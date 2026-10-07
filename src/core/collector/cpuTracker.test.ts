import { expect, test } from 'vitest';
import type { ProcSample } from '../types';
import { CpuTracker } from './cpuTracker';

const sample = (pid: number, cpuTicks: number, startTicks = 100): ProcSample => ({
  pid, ppid: 1, name: 'x', cmdline: 'x', uid: 1000, startTicks, ageSec: 10, cpuTicks, rssKB: 0, swapKB: 0, cwd: null, cwdDeleted: false,
});

test('première lecture → 0 %', () => {
  expect(new CpuTracker().update([sample(1, 500)], 0)[0].cpuPercent).toBe(0);
});

test('200 ticks en 2 s → 100 % d\'un cœur', () => {
  const t = new CpuTracker();
  t.update([sample(1, 500)], 0);
  expect(t.update([sample(1, 700)], 2000)[0].cpuPercent).toBe(100);
});

test('PID réutilisé (starttime différent) → 0 %, jamais négatif', () => {
  const t = new CpuTracker();
  t.update([sample(1, 9000, 100)], 0);
  expect(t.update([sample(1, 10, 555)], 2000)[0].cpuPercent).toBe(0);
});

test('compteur qui recule sans changement de starttime → 0 %', () => {
  const t = new CpuTracker();
  t.update([sample(1, 900)], 0);
  expect(t.update([sample(1, 800)], 2000)[0].cpuPercent).toBe(0);
});
