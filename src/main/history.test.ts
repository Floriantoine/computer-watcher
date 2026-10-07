import { mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { DEFAULT_RECORDER } from '../core/defaults';
import { openHistoryDb } from '../core/history/db';
import { HistoryWriter } from '../core/history/writer';
import { dbPath, statusPath } from '../core/paths';
import type { Group, ProcInfo, SystemInfo } from '../core/types';
import { createHistoryReader } from './history';

const sys: SystemInfo = { memTotalKB: 1000, memAvailableKB: 400, swapTotalKB: 2000, swapFreeKB: 500, load1: 1.5, psiSome10: 3 };
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
  new HistoryWriter(db).writeTick({ ts, system: sys, cpuPercent: 1, groups: [g], procs: [p] }, { procMinMemMB: 50, procMinCpuPercent: 1 });
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

test('createHistoryReader : null sans base, données avec base, récupère après remplacement du fichier', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-hist-'));
  const reader = createHistoryReader(dir, () => DEFAULT_RECORDER);
  const range = { from: Date.now() - 60_000, to: Date.now() + 60_000 };
  expect(reader.system(range)).toBeNull();
  expect(reader.top(range)).toEqual([]);
  expect(reader.status()).toBeNull();

  makeDb(dir, Date.now());
  expect(reader.system(range)?.memUsedKB).toEqual([600]);

  // remplacement : base recréée avec un autre échantillon
  const other = mkdtempSync(join(tmpdir(), 'pw-hist2-'));
  makeDb(other, Date.now() + 1000);
  renameSync(dbPath(other), dbPath(dir));
  // Ne lève jamais : renvoie des données (ancienne ou nouvelle base) ou null, puis se rouvre sur la nouvelle au besoin.
  const results = [reader.system(range), reader.system(range), reader.system(range)];
  expect(results.some((r) => r?.memTotalKB === 1000)).toBe(true);

  writeFileSync(statusPath(dir), JSON.stringify({ pid: 1, startedAt: 0, lastSampleAt: 5, lastError: null, earlyoomSource: 'ok', dbSizeBytes: 1 }));
  expect(reader.status()?.pid).toBe(1);
});
