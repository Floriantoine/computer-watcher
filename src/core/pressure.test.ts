import { describe, expect, test } from 'vitest';
import { pressureLevel, swapPercent } from './pressure';
import type { SystemInfo } from './types';

const sys = (swapUsedPct: number, psi: number | null): SystemInfo => ({
  memTotalKB: 100, memAvailableKB: 50, swapTotalKB: 100, swapFreeKB: 100 - swapUsedPct, load1: 1, psiSome10: psi, shmemKB: 0,
});

describe('pressureLevel', () => {
  test.each([
    [10, 0, 'ok'], [49, 0, 'ok'], [50, 0, 'warn'], [69, 0, 'warn'], [70, 0, 'bad'],
    [0, 9, 'ok'], [0, 10, 'warn'], [0, 24, 'warn'], [0, 25, 'bad'], [0, null, 'ok'],
  ])('swap %i %%, PSI %s → %s', (swap, psi, level) => {
    expect(pressureLevel(sys(swap, psi))).toBe(level);
  });
  test('pas de swap → ok', () => {
    expect(pressureLevel({ ...sys(0, 0), swapTotalKB: 0, swapFreeKB: 0 })).toBe('ok');
  });
});

describe('swapPercent', () => {
  test('part utilisée ; sans swap → 0', () => {
    expect(swapPercent(sys(30, 0))).toBeCloseTo(30);
    expect(swapPercent({ ...sys(0, 0), swapTotalKB: 0, swapFreeKB: 0 })).toBe(0);
  });
});
