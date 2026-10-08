import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { Group, ProcInfo, SystemInfo } from '../types';
import { openHistoryDb } from './db';
import { HistoryWriter, SMALL_GROUPS_KEY } from './writer';

const sys: SystemInfo = { memTotalKB: 1000, memAvailableKB: 400, swapTotalKB: 2000, swapFreeKB: 500, load1: 1.5, psiSome10: 3, shmemKB: 77 };
const proc = (pid: number, extra: Partial<ProcInfo> = {}): ProcInfo => ({
  pid, ppid: 1, name: 'node', cmdline: 'node x', uid: 1000, startTicks: 100, ageSec: 1, cpuTicks: 0, cpuPercent: 0,
  rssKB: 0, swapKB: 0, cwd: null, cwdDeleted: false, ...extra,
});
const group = (id: string, procs: ProcInfo[]): Group => ({
  id, kind: 'command', label: id, tags: [], rootName: 'x', roots: procs.map((p) => ({ proc: p, children: [] })), pids: procs.map((p) => p.pid),
  procCount: procs.length, cpuPercent: procs.reduce((s, p) => s + p.cpuPercent, 0), rssKB: procs.reduce((s, p) => s + p.rssKB, 0),
  swapKB: procs.reduce((s, p) => s + p.swapKB, 0), oldestAgeSec: 1, protected: false, killable: true, subgroups: [],
});
const T = { procMinMemMB: 50, procMinCpuPercent: 1, groupMinMemMB: 0 };
const open = () => openHistoryDb(join(mkdtempSync(join(tmpdir(), 'pw-w-')), 'm.db')).db;

test('écrit système, tous les groupes, et seulement les processus au-dessus des seuils', () => {
  const db = open();
  const big = proc(10, { rssKB: 60 * 1024 });
  const busy = proc(11, { rssKB: 10, cpuPercent: 5 });
  const small = proc(12, { rssKB: 10 });
  const w = new HistoryWriter(db);
  const r = w.writeTick({ ts: 1000, system: sys, cpuPercent: 12, groups: [group('command:node', [big, busy, small]), group('command:tiny', [proc(13)])], procs: [big, busy, small, proc(13)] }, T);
  expect(r).toEqual({ groups: 2, procs: 2 });
  expect(db.prepare('SELECT * FROM system_samples').all()).toEqual([
    { ts: 1000, mem_used_kb: 600, mem_total_kb: 1000, swap_used_kb: 1500, swap_total_kb: 2000, psi_some10: 3, load1: 1.5, cpu_percent: 12, shmem_kb: 77 },
  ]);
  expect((db.prepare('SELECT key FROM groups ORDER BY key').all() as { key: string }[]).map((g) => g.key)).toEqual(['command:node', 'command:tiny']);
  expect((db.prepare('SELECT pid FROM procs ORDER BY pid').all() as { pid: number }[]).map((p) => p.pid)).toEqual([10, 11]);
});

test('PID réutilisé : deux processus distincts', () => {
  const db = open();
  const w = new HistoryWriter(db);
  const a = proc(10, { rssKB: 60 * 1024, startTicks: 100 });
  const b = proc(10, { rssKB: 60 * 1024, startTicks: 999, cmdline: 'autre' });
  w.writeTick({ ts: 1000, system: sys, cpuPercent: 0, groups: [group('g', [a])], procs: [a] }, T);
  w.writeTick({ ts: 6000, system: sys, cpuPercent: 0, groups: [group('g', [b])], procs: [b] }, T);
  expect(db.prepare('SELECT pid, start_ticks, cmdline FROM procs ORDER BY start_ticks').all()).toEqual([
    { pid: 10, start_ticks: 100, cmdline: 'node x' },
    { pid: 10, start_ticks: 999, cmdline: 'autre' },
  ]);
  expect((db.prepare('SELECT COUNT(*) n FROM proc_samples').get() as { n: number }).n).toBe(2);
});

test('libellé de groupe mis à jour, id stable', () => {
  const db = open();
  const w = new HistoryWriter(db);
  const g1 = { ...group('project:/a', []), label: 'ancien' };
  const g2 = { ...group('project:/a', []), label: 'nouveau' };
  w.writeTick({ ts: 1, system: sys, cpuPercent: 0, groups: [g1], procs: [] }, T);
  w.writeTick({ ts: 2, system: sys, cpuPercent: 0, groups: [g2], procs: [] }, T);
  expect(db.prepare('SELECT id, label FROM groups').all()).toEqual([{ id: 1, label: 'nouveau' }]);
});

test('PSI absent → NULL', () => {
  const db = open();
  new HistoryWriter(db).writeTick({ ts: 1, system: { ...sys, psiSome10: null }, cpuPercent: 0, groups: [], procs: [] }, T);
  expect((db.prepare('SELECT psi_some10 FROM system_samples').get() as { psi_some10: null }).psi_some10).toBeNull();
});

test('ppid écrit à la création, mis à jour une seule fois au reparentage', () => {
  const db = open();
  const w = new HistoryWriter(db);
  const tick = (ts: number, ppid: number) => {
    const p = proc(10, { rssKB: 60 * 1024, ppid });
    w.writeTick({ ts, system: sys, cpuPercent: 0, groups: [group('g', [p])], procs: [p] }, T);
  };
  const ppid = () => (db.prepare('SELECT ppid FROM procs').get() as { ppid: number }).ppid;
  tick(1000, 5);
  expect(ppid()).toBe(5);
  db.exec('CREATE TEMP TABLE upd(n)');
  db.exec('CREATE TEMP TRIGGER t AFTER UPDATE ON main.procs BEGIN INSERT INTO upd VALUES(1); END');
  tick(6000, 5);
  tick(11000, 5);
  expect((db.prepare('SELECT COUNT(*) n FROM upd').get() as { n: number }).n).toBe(0);
  tick(16000, 1);
  tick(21000, 1);
  expect(ppid()).toBe(1);
  expect((db.prepare('SELECT COUNT(*) n FROM upd').get() as { n: number }).n).toBe(1);
});

test('petits groupes (< groupMinMemMB et CPU < procMinCpuPercent) cumulés dans un seul groupe « Petits groupes »', () => {
  const db = open();
  const w = new HistoryWriter(db);
  const big = proc(10, { rssKB: 30 * 1024 });
  const busy = proc(11, { rssKB: 100, cpuPercent: 2 });
  const a = proc(12, { rssKB: 5 * 1024, swapKB: 1024, cpuPercent: 0.2 });
  const b = proc(13, { rssKB: 2 * 1024, cpuPercent: 1.5 }); // processus actif dans un groupe peu actif : gardé
  const b2 = proc(14, { rssKB: 1024 });
  const gb = { ...group('command:b', [b, b2]), cpuPercent: 0.9 };
  const r = w.writeTick(
    { ts: 1000, system: sys, cpuPercent: 0, groups: [group('app:big', [big]), group('command:busy', [busy]), group('command:a', [a]), gb], procs: [big, busy, a, b, b2] },
    { ...T, groupMinMemMB: 20 },
  );
  expect(r).toEqual({ groups: 3, procs: 2 });
  expect(db.prepare('SELECT key, label, kind FROM groups ORDER BY id').all()).toEqual([
    { key: 'app:big', label: 'app:big', kind: 'command' },
    { key: 'command:busy', label: 'command:busy', kind: 'command' },
    { key: SMALL_GROUPS_KEY, label: 'Petits groupes', kind: 'others' },
  ]);
  expect(db.prepare('SELECT g.key, s.rss_kb, s.swap_kb, s.cpu_percent, s.proc_count FROM group_samples s JOIN groups g ON g.id = s.group_id WHERE g.key = ?').get(SMALL_GROUPS_KEY)).toEqual({
    key: SMALL_GROUPS_KEY, rss_kb: 5 * 1024 + 3 * 1024, swap_kb: 1024, cpu_percent: 0.2 + 0.9, proc_count: 3,
  });
  // processus enregistrés : busy (CPU) dans son groupe, b (CPU) rattaché aux petits groupes
  expect(db.prepare('SELECT p.pid, g.key FROM procs p JOIN groups g ON g.id = p.group_id ORDER BY p.pid').all()).toEqual([
    { pid: 11, key: 'command:busy' }, { pid: 13, key: SMALL_GROUPS_KEY },
  ]);
});

test('aucun petit groupe : pas de ligne « Petits groupes »', () => {
  const db = open();
  const big = proc(10, { rssKB: 30 * 1024 });
  new HistoryWriter(db).writeTick({ ts: 1, system: sys, cpuPercent: 0, groups: [group('app:big', [big])], procs: [big] }, { ...T, groupMinMemMB: 20 });
  expect(db.prepare('SELECT key FROM groups').all()).toEqual([{ key: 'app:big' }]);
});
