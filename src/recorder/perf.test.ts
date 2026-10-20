// src/recorder/perf.test.ts
import { homedir } from 'node:os';
import { expect, test } from 'vitest';
import { probeAvailability, readCgroup, readCgroupStats } from '../core/antigel/cgroupfs';
import { createAntigel } from '../core/antigel/controller';
import { fakeSystemd } from '../core/antigel/testFixtures';
import { CpuTracker } from '../core/collector/cpuTracker';
import { readProcesses } from '../core/collector/readProcesses';
import { readSystem } from '../core/collector/readSystem';
import { claudeDirs } from '../core/grouping/claudeDirs';
import { buildGroups } from '../core/grouping/buildGroups';
import { createProjectRootCache } from '../core/grouping/projectRootCache';
import { isDevTool } from '../core/grouping/rules';

// Mesure la vraie machine, sensible au timing : lancé par `npm run test:recorder` (PROC_WATCH_PERF=1)
test.skipIf(process.env.PROC_WATCH_PERF !== '1')('un tick de collecte sur le vrai /proc reste rapide', () => {
  const tracker = new CpuTracker();
  const cmdlineCache = new Map<string, string>();
  const projectRootOf = createProjectRootCache();
  const run = () =>
    buildGroups(tracker.update(readProcesses('/proc', { wantCwd: isDevTool, cmdlineCache }), Date.now()), {
      home: '/home/x', currentUid: process.getuid!(), isProtected: () => false, othersThreshold: { memMB: 0, cpuPercent: 0 }, projectRootOf,
    });
  run(); // chauffe
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) run();
  const ms = (performance.now() - t0) / 10;
  console.log(`tick: ${ms.toFixed(1)} ms`);
  expect(ms).toBeLessThan(35);
});

// Coût de l'anti-gel dans le tick, en régime établi, sur le vrai /proc et le vrai /sys/fs/cgroup (lecture seule). Faux
// client systemd (fakeSystemd : aucun busctl, aucun D-Bus) et revérification vide : aucun déplacement n'est même tenté.
test.skipIf(process.env.PROC_WATCH_PERF !== '1')('anti-gel : coût du tick en régime établi sur le vrai /proc (faux client, aucun D-Bus)', async () => {
  const uid = process.getuid!();
  const real = probeAvailability({ procRoot: '/proc', sysfsRoot: '/sys/fs/cgroup', uid, selfPid: process.pid, busctl: '/usr/bin/busctl' });
  // sans cgroups v2 délégués ici (machine de CI…), la mesure se fait quand même, sur une base utilisateur fictive
  if (!real.ok) console.log(`anti-gel: disponibilité réelle absente (${real.reason}), mesure sur une base fictive`);
  const avail = real.ok ? real : { ok: true as const, userBase: `/user.slice/user-${uid}.slice/user@${uid}.service`, busctl: '/usr/bin/busctl' };
  const fake = fakeSystemd({ userBase: avail.userBase });
  const ag = createAntigel({
    client: fake.client, probe: () => avail, stats: (p) => readCgroupStats('/sys/fs/cgroup', p), cgroupOf: (pid) => readCgroup('/proc', pid),
    reverify: () => [], monoNow: () => performance.now(), log: () => {},
  });
  const tracker = new CpuTracker();
  const cmdlineCache = new Map<string, string>();
  const projectRootOf = createProjectRootCache();
  const dirs = claudeDirs();
  const input = () => {
    const procs = tracker.update(readProcesses('/proc', { wantCwd: isDevTool, cmdlineCache }), Date.now());
    const groups = buildGroups(procs, { home: homedir(), currentUid: uid, isProtected: () => false, othersThreshold: { memMB: 0, cpuPercent: 0 }, projectRootOf, claudeDirs: dirs });
    return {
      ts: Date.now(), procs, groups, system: readSystem('/proc'), config: { enabled: true, reserveMB: null, budgets: {} }, currentUid: uid,
      selfPid: process.pid, appRoot: null, isProtected: () => false, home: homedir(), claudeDirs: dirs,
    };
  };
  ag.tick(input()); // chauffe (cwatch.slice « assurée » par le faux client)
  await ag.idle();
  const ins = Array.from({ length: 10 }, input);
  const t0 = performance.now();
  for (const i of ins) {
    ag.tick(i);
    await ag.idle();
  }
  const ms = (performance.now() - t0) / 10;
  console.log(`anti-gel: ${ms.toFixed(2)} ms par tick`);
  // aucun scope ni slice de projet : la revérification vide arrête tout avant l'appel
  expect(fake.calls.filter((c) => c[0] !== 'ensureSlice')).toEqual([]);
  expect(ms).toBeLessThan(5);
});
