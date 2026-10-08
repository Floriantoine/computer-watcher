import { existsSync, mkdtempSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { DEFAULT_RECORDER } from '../core/defaults';
import { openHistoryDb } from '../core/history/db';
import { HistoryWriter } from '../core/history/writer';
import { clearRequestPath, dbPath, statusPath } from '../core/paths';
import type { Group, ProcInfo, SystemInfo } from '../core/types';
import { clearHistory, createHistoryReader, recorderProcessAlive } from './history';

const sys: SystemInfo = { memTotalKB: 1000, memAvailableKB: 400, swapTotalKB: 2000, swapFreeKB: 500, load1: 1.5, psiSome10: 3, shmemKB: 0 };
const p: ProcInfo = {
  pid: 10, ppid: 1, name: 'node', cmdline: 'node x', uid: 1000, startTicks: 100, ageSec: 1, cpuTicks: 0, cpuPercent: 0,
  rssKB: 60 * 1024, swapKB: 0, cwd: null, cwdDeleted: false,
};
const g: Group = {
  id: 'command:node', kind: 'command', label: 'node', tags: [], rootName: 'x', roots: [{ proc: p, children: [] }], pids: [10], procCount: 1,
  cpuPercent: 0, rssKB: p.rssKB, swapKB: 0, oldestAgeSec: 1, protected: false, killable: true, subgroups: [],
};

function makeDb(dir: string, ts: number): void {
  const { db } = openHistoryDb(dbPath(dir));
  new HistoryWriter(db).writeTick({ ts, system: sys, cpuPercent: 1, groups: [g], procs: [p] }, { procMinMemMB: 50, procMinCpuPercent: 1, groupMinMemMB: 0 });
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

test('createHistoryReader : null sans base, données avec base, récupère après remplacement du fichier', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-hist-'));
  const reader = createHistoryReader(dir, () => DEFAULT_RECORDER);
  const range = { from: Date.now() - 60_000, to: Date.now() + 60_000 };
  expect(reader.system(range)).toBeNull();
  expect(reader.top(range)).toEqual({ byAvg: [], byMax: [] });
  expect(reader.status()).toBeNull();

  makeDb(dir, Date.now());
  expect(reader.system(range)?.memUsedKB).toEqual([600]);

  expect(reader.system(range)?.memUsedKB).toEqual([600]);

  // remplacement comme openHistoryDb : ancien fichier renommé (+ wal/shm), nouvelle base avec un autre échantillon
  for (const ext of ['', '-wal', '-shm']) {
    try {
      renameSync(dbPath(dir) + ext, dbPath(dir) + '.bak' + ext);
    } catch {
      // absent
    }
  }
  const { db: ndb } = openHistoryDb(dbPath(dir));
  const g2: Group = { ...g, rssKB: 10 };
  new HistoryWriter(ndb).writeTick({ ts: Date.now(), system: { ...sys, memAvailableKB: 100 }, cpuPercent: 1, groups: [g2], procs: [p] }, { procMinMemMB: 50, procMinCpuPercent: 1, groupMinMemMB: 0 });
  ndb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  ndb.close();
  expect(reader.system(range)?.memUsedKB).toEqual([900]);

  // base supprimée : null
  unlinkSync(dbPath(dir));
  expect(reader.system(range)).toBeNull();

  writeFileSync(statusPath(dir), JSON.stringify({ pid: 1, startedAt: 0, lastSampleAt: 5, lastError: null, earlyoomSource: 'ok', dbSizeBytes: 1 }));
  expect(reader.status()?.pid).toBe(1);
});

test('history.active : null sans base, ensemble avec base, null (et erreur journalisée) si la requête échoue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-hist-'));
  const reader = createHistoryReader(dir, () => DEFAULT_RECORDER);
  const targets = [{ pid: 10, startTicks: 100 }];
  expect(reader.active(targets, 0)).toBeNull();

  makeDb(dir, Date.now());
  // enregistré (60 Mo) mais CPU 0 : inactif, la base répond par un ensemble vide (≠ null)
  expect(reader.active(targets, 0)).toEqual(new Set());

  // base illisible pour cette requête : erreur journalisée, null
  reader.close();
  const { db } = openHistoryDb(dbPath(dir));
  db.exec('DROP TABLE proc_samples');
  db.close();
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(reader.active(targets, 0)).toBeNull();
    expect(err).toHaveBeenCalledWith('history:', expect.anything());
  } finally {
    err.mockRestore();
  }
});

test('history.lastActive / from (vue swap) : null sans base, valeurs avec base, cache vidé à la fermeture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-hist-'));
  const reader = createHistoryReader(dir, () => DEFAULT_RECORDER);
  const targets = [{ pid: 10, startTicks: 100 }];
  expect(reader.lastActive(targets, 86_400_000)).toBeNull();
  expect(reader.from()).toBeNull();
  const now = Date.now();
  makeDb(dir, now);
  // enregistré mais CPU 0 : jamais actif → null (≠ base absente)
  expect(reader.lastActive(targets, 86_400_000)).toEqual(new Map([['10:100', null]]));
  expect(reader.from()).not.toBeNull();
  reader.close();
  expect(reader.lastActive(targets, 86_400_000)).toEqual(new Map([['10:100', null]]));
});

const backups = ['metrics.db.pre-v2-20261007T094000', 'metrics.db.bak-20261001T000000', 'metrics.db.bak-20261001T000000-wal'];

test('clearHistory, service arrêté : l\'app supprime la base (+wal/shm) et les copies de sécurité', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-hist-'));
  makeDb(dir, Date.now());
  writeFileSync(dbPath(dir) + '-wal', '');
  for (const f of backups) writeFileSync(join(dir, f), 'x');
  const reader = createHistoryReader(dir, () => DEFAULT_RECORDER);
  expect(reader.system({ from: 0, to: Date.now() + 1 })).not.toBeNull(); // connexion ouverte
  expect(clearHistory(dir, { running: false, beforeDelete: reader.close })).toEqual({ mode: 'deleted', backups: 2 });
  expect(readdirSync(dir)).toEqual([]);
  expect(reader.system({ from: 0, to: Date.now() + 1 })).toBeNull();
});

test('clearHistory, service actif : demande au service, copies de sécurité supprimées, base intacte', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-hist-'));
  makeDb(dir, Date.now());
  for (const f of backups) writeFileSync(join(dir, f), 'x');
  expect(clearHistory(dir, { running: true })).toEqual({ mode: 'requested', backups: 2 });
  expect(existsSync(dbPath(dir))).toBe(true);
  expect(existsSync(clearRequestPath(dir))).toBe(true);
  expect(readdirSync(dir).filter((f) => f.includes('.bak') || f.includes('.pre-v'))).toEqual([]);
});

test('clearHistory, base d\'une version plus récente : supprimée par l\'app même si le service répond', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-hist-'));
  makeDb(dir, Date.now());
  const { db } = openHistoryDb(dbPath(dir));
  db.exec('PRAGMA user_version = 99');
  db.close();
  expect(clearHistory(dir, { running: true })).toEqual({ mode: 'deleted', backups: 0 });
  expect(existsSync(dbPath(dir))).toBe(false);
  expect(existsSync(clearRequestPath(dir))).toBe(false);
});

test('clearHistory, service jugé arrêté mais processus vivant : passe par clear-request, base conservée', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-hist-'));
  makeDb(dir, Date.now());
  const seen: number[] = [];
  const isAlive = (pid: number) => (seen.push(pid), true);
  expect(clearHistory(dir, { running: false, pid: 4242, isAlive })).toEqual({ mode: 'requested', backups: 0 });
  expect(seen).toEqual([4242]);
  expect(existsSync(dbPath(dir))).toBe(true);
  expect(existsSync(clearRequestPath(dir))).toBe(true);
});

test('clearHistory, service arrêté et processus mort (ou pid inconnu) : suppression par l\'app', () => {
  for (const pid of [4242, undefined]) {
    const dir = mkdtempSync(join(tmpdir(), 'pw-hist-'));
    makeDb(dir, Date.now());
    expect(clearHistory(dir, { running: false, pid, isAlive: () => false })).toEqual({ mode: 'deleted', backups: 0 });
    expect(existsSync(dbPath(dir))).toBe(false);
  }
});

test('clearHistory, pid absent : isAlive n\'est pas appelé', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-hist-'));
  makeDb(dir, Date.now());
  expect(clearHistory(dir, { running: false, isAlive: () => { throw new Error('non'); } }).mode).toBe('deleted');
});

test('clearHistory, base plus récente et processus vivant : suppression autorisée', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-hist-'));
  makeDb(dir, Date.now());
  const { db } = openHistoryDb(dbPath(dir));
  db.exec('PRAGMA user_version = 99');
  db.close();
  expect(clearHistory(dir, { running: false, pid: 1, isAlive: () => true }).mode).toBe('deleted');
});

test('recorderProcessAlive (réel) : pid réattribué, mort, invalide, cmdline illisible', async () => {
  const { spawn } = await import('node:child_process');
  expect(recorderProcessAlive(process.pid)).toBe(false); // vivant mais pas recorder.js : pid réutilisé
  expect(recorderProcessAlive(process.pid, () => 'node\0recorder.js\0')).toBe(true);
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => child.on('exit', r));
  expect(recorderProcessAlive(child.pid!)).toBe(false);
  for (const bad of [0, -1, NaN, '12' as unknown as number]) expect(recorderProcessAlive(bad)).toBe(true);
  const eacces = () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); };
  expect(recorderProcessAlive(process.pid, eacces)).toBe(true);
  const enoent = () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
  expect(recorderProcessAlive(process.pid, enoent)).toBe(false);
});
