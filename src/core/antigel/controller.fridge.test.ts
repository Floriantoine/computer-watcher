// Lot 3 : le contrôleur ne range plus rien dans la slice d'un projet au frigo (faux client, aucun busctl).
import { expect, test } from 'vitest';
import { buildGroups } from '../grouping/buildGroups';
import type { ProcInfo, SystemInfo } from '../types';
import type { AntigelConfig } from './config';
import { createAntigel } from './controller';
import { fakeSystemd } from './testFixtures';

const BASE = '/user.slice/user-1000.slice/user@1000.service';
const WARP = `${BASE}/app.slice/app-dev.warp.Warp@1.service`;
const A = '/home/u/alpha';
const ON: AntigelConfig = { enabled: true, reserveMB: null, budgets: {} };
const SYS: SystemInfo = { memTotalKB: 16 * 1024 * 1024, memAvailableKB: 8 * 1024 * 1024, swapTotalKB: 8 * 1024 * 1024, swapFreeKB: 8 * 1024 * 1024, load1: 1, psiSome10: null, shmemKB: null };
let stc = 1;
const p = (pid: number, ppid: number, name: string, cmdline: string, cwd: string | null = null): ProcInfo => ({
  pid, ppid, name, cmdline, uid: 1000, startTicks: stc++, ageSec: 10, cpuTicks: 0, cpuPercent: 0, rssKB: 100_000, swapKB: 0, cwd, cwdDeleted: false,
});

test('projet au frigo : aucun scope vers sa slice ; au réveil, ses nouveaux processus sont rangés', async () => {
  const fake = fakeSystemd({ userBase: BASE });
  let mono = 0;
  const ag = createAntigel({
    client: fake.client, probe: () => ({ ok: true, userBase: BASE, busctl: '/usr/bin/busctl' }), reverify: (t) => [...t], log: () => {},
    monoNow: () => mono, perfNow: () => 0, stats: (path) => fake.sys.get(path) ?? null, cgroupOf: (pid) => fake.cg.get(pid) ?? WARP,
  });
  const procs = [
    p(600, 500, 'warp', 'warp'), p(601, 600, 'zsh', 'zsh', A),
    p(700, 601, 'MainThread', `node ${A}/node_modules/vitest/vitest.mjs run`, A),
  ];
  const tick = async (frozen?: Set<string>) => {
    mono += 5000;
    ag.tick({
      ts: 1_000_000 + mono, procs, system: SYS, config: ON, currentUid: 1000, selfPid: 900, appRoot: null, home: '/home/u',
      isProtected: (n) => ['zsh', 'warp'].includes(n), frozenSlices: frozen,
      groups: buildGroups(procs, { home: '/home/u', currentUid: 1000, isProtected: () => false, othersThreshold: { memMB: 0, cpuPercent: 0 }, projectRootOf: (c) => (c.startsWith(A) ? A : null) }),
    });
    await ag.idle();
  };
  await tick(new Set(['cwatch-p-alpha.slice']));
  await tick(new Set(['cwatch-p-alpha.slice']));
  expect(fake.calls.map((c) => c[0])).toEqual(['ensureSlice']);
  await tick(new Set());
  expect(fake.calls.map((c) => c[0])).toEqual(['ensureSlice', 'ensureProjectSlice', 'startScope']);
});
