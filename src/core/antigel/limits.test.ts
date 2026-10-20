import { expect, test } from 'vitest';
import { GiB, MiB, autoReserveBytes, budgetBytes, sameLimits, sliceLimits } from './limits';

const KB = (bytes: number) => bytes / 1024;

test('réserve automatique : max(4 Go, 15 % de la RAM)', () => {
  expect(autoReserveBytes(16 * GiB)).toBe(4 * GiB);
  expect(autoReserveBytes(40 * GiB)).toBe(6 * GiB);
});

test('plafonds : MemoryHigh = RAM − réserve, MemoryMax = RAM − réserve/2, swap/2', () => {
  expect(sliceLimits(KB(16 * GiB), KB(8 * GiB), null)).toEqual({ reserveBytes: 4 * GiB, highBytes: 12 * GiB, maxBytes: 14 * GiB, swapMaxBytes: 4 * GiB });
  expect(sliceLimits(KB(40 * GiB), KB(20 * GiB), null)).toEqual({ reserveBytes: 6 * GiB, highBytes: 34 * GiB, maxBytes: 37 * GiB, swapMaxBytes: 10 * GiB });
  expect(sliceLimits(KB(16 * GiB), KB(8 * GiB), 6144)).toEqual({ reserveBytes: 6 * GiB, highBytes: 10 * GiB, maxBytes: 13 * GiB, swapMaxBytes: 4 * GiB });
});

test('sans swap : MemorySwapMax = 0 ; valeurs alignées sur la page', () => {
  const l = sliceLimits(KB(16 * GiB) + 3, 0, null)!;
  expect(l.swapMaxBytes).toBe(0);
  for (const v of [l.highBytes, l.maxBytes]) expect(v % 4096).toBe(0);
});

test('petite machine ou réserve trop grande : moins de 1 Go laissé au travail → aucun plafond', () => {
  expect(sliceLimits(KB(16 * GiB), 0, 15 * 1024)!.highBytes).toBe(GiB);
  expect(sliceLimits(KB(16 * GiB), 0, 15 * 1024 + 1)).toBeNull();
  expect(sliceLimits(KB(4 * GiB), 0, null)).toBeNull(); // 4 Go de RAM, 4 Go de réserve
  expect(sliceLimits(0, 0, null)).toBeNull();
  expect(sliceLimits(Number.NaN, 0, null)).toBeNull();
});

test('sameLimits, budgetBytes', () => {
  const a = sliceLimits(KB(16 * GiB), KB(8 * GiB), null);
  expect(sameLimits(a, sliceLimits(KB(16 * GiB), KB(8 * GiB), null))).toBe(true);
  expect(sameLimits(a, sliceLimits(KB(16 * GiB), KB(8 * GiB), 6144))).toBe(false);
  expect(sameLimits(null, null)).toBe(true);
  expect(sameLimits(a, null)).toBe(false);
  expect(budgetBytes(4096)).toBe(4 * GiB);
  expect(MiB * 1024).toBe(GiB);
});

test('réserve invalide (NaN, négative, 0, hors bornes) → aucun plafond', () => {
  for (const r of [Number.NaN, -1, -4096, 0, 1023, 1_048_577, Infinity]) expect(sliceLimits(KB(16 * GiB), 0, r), String(r)).toBeNull();
  expect(sliceLimits(KB(16 * GiB), KB(8 * GiB), 1024)).not.toBeNull();
});
