import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { Group, ProcInfo, SystemInfo } from '../types';
import { openHistoryDb } from './db';
import { HistoryWriter } from './writer';

const sys: SystemInfo = { memTotalKB: 1000, memAvailableKB: 400, swapTotalKB: 2000, swapFreeKB: 500, load1: 1.5, psiSome10: 3 };
const proc = (pid: number, extra: Partial<ProcInfo> = {}): ProcInfo => ({
  pid, ppid: 1, name: 'node', cmdline: 'node x', uid: 1000, startTicks: 100, ageSec: 1, cpuTicks: 0, cpuPercent: 0,
  rssKB: 0, swapKB: 0, cwd: null, cwdDeleted: false, ...extra,
});
const group = (id: string, procs: ProcInfo[]): Group => ({
  id, kind: 'command', label: id, tags: [], rootName: 'x', roots: procs.map((p) => ({ proc: p, children: [] })), pids: procs.map((p) => p.pid),
  procCount: procs.length, cpuPercent: procs.reduce((s, p) => s + p.cpuPercent, 0), rssKB: procs.reduce((s, p) => s + p.rssKB, 0),
  swapKB: procs.reduce((s, p) => s + p.swapKB, 0), oldestAgeSec: 1, protected: false, killable: true, subgroups: [],
});
const T = { procMinMemMB: 50, procMinCpuPercent: 1 };
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
    { ts: 1000, mem_used_kb: 600, mem_total_kb: 1000, swap_used_kb: 1500, swap_total_kb: 2000, psi_some10: 3, load1: 1.5, cpu_percent: 12 },
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
