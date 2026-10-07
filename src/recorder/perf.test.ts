// src/recorder/perf.test.ts
import { expect, test } from 'vitest';
import { CpuTracker } from '../core/collector/cpuTracker';
import { readProcesses } from '../core/collector/readProcesses';
import { buildGroups } from '../core/grouping/buildGroups';
import { createProjectRootCache } from '../core/grouping/projectRootCache';
import { DEV_TOOL } from '../core/grouping/rules';

test('un tick de collecte sur le vrai /proc reste rapide', () => {
  const tracker = new CpuTracker();
  const projectRootOf = createProjectRootCache();
  const run = () =>
    buildGroups(tracker.update(readProcesses('/proc', { wantCwd: (n) => DEV_TOOL.test(n) }), Date.now()), {
      home: '/home/x', currentUid: process.getuid!(), isProtected: () => false, othersThreshold: { memMB: 0, cpuPercent: 0 }, projectRootOf,
    });
  run(); // chauffe
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) run();
  const ms = (performance.now() - t0) / 10;
  console.log(`tick: ${ms.toFixed(1)} ms`);
  expect(ms).toBeLessThan(25);
});
