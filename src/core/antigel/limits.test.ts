import { describe, expect, test } from 'vitest';
import { DYN_FLOOR_BYTES, GiB, MiB, autoReserveBytes, budgetBytes, dynamicHigh, dynamicLimits, sameLimits, sliceLimits, type SliceLimits } from './limits';

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

describe('plafond dynamique : MemoryHigh = travail + max(0, MemAvailable − réserve), borné', () => {
  const L = sliceLimits(KB(16 * GiB), KB(8 * GiB), null)!; // réserve 4 Go, statique 12 Go, arrêt 14 Go
  const at = (workBytes: number, availKB: number | null, applied: SliceLimits | null = null) => dynamicLimits(L, { workBytes, availKB }, applied);

  test('marge = MemAvailable − réserve au-dessus du travail actuel ; MemoryMax et swap statiques', () => {
    expect(at(3 * GiB, KB(6 * GiB))).toEqual({ ...L, highBytes: 5 * GiB });
    expect(dynamicHigh(L, 3 * GiB, KB(6 * GiB))).toBe(5 * GiB);
  });
  test('RAM pleine hors travail : plafond = travail (aucune croissance), jamais sous le plancher de 1 Go', () => {
    expect(dynamicHigh(L, 5 * GiB, KB(2 * GiB))).toBe(5 * GiB);
    expect(dynamicHigh(L, 200 * MiB, KB(GiB))).toBe(DYN_FLOOR_BYTES);
    expect(DYN_FLOOR_BYTES).toBe(GiB);
  });
  test('beaucoup de RAM libre : jamais au-dessus du plafond statique (RAM − réserve)', () => {
    expect(dynamicHigh(L, 2 * GiB, KB(15 * GiB))).toBe(12 * GiB);
  });
  test('MemAvailable illisible : plafond statique', () => {
    expect(at(3 * GiB, null)).toEqual(L);
    expect(dynamicHigh(L, 3 * GiB, Number.NaN)).toBe(12 * GiB);
    expect(dynamicHigh(L, Number.NaN, KB(6 * GiB))).toBe(12 * GiB);
  });
  test('aligné sur la page', () => {
    expect(dynamicHigh(L, 3 * GiB + 123, KB(6 * GiB) + 5) % 4096).toBe(0);
  });
  test('hystérésis : écart < max(256 Mo, 5 %) → plafond déjà posé gardé ; au-delà, ou atteinte d’une borne, réécrit', () => {
    const applied = { ...L, highBytes: 5 * GiB };
    expect(at(3 * GiB + 200 * MiB, KB(6 * GiB), applied)).toBe(applied); // 200 Mo de plus : gardé
    expect(at(3 * GiB - 200 * MiB, KB(6 * GiB), applied)).toBe(applied);
    expect(at(3 * GiB + 300 * MiB, KB(6 * GiB), applied).highBytes).toBe(5 * GiB + 300 * MiB);
    const big = { ...L, highBytes: 10 * GiB }; // 5 % de 10 Go = 512 Mo
    expect(at(6 * GiB, KB(8 * GiB + 400 * MiB), big)).toBe(big);
    expect(at(6 * GiB, KB(8 * GiB + 600 * MiB), big).highBytes).toBe(10 * GiB + 600 * MiB);
    // borne atteinte : réécrite même pour quelques Mo (sinon le plafond resterait juste sous le statique)
    expect(at(2 * GiB, KB(15 * GiB), { ...L, highBytes: 12 * GiB - 100 * MiB }).highBytes).toBe(12 * GiB);
    expect(at(100 * MiB, KB(GiB), { ...L, highBytes: GiB + 100 * MiB }).highBytes).toBe(GiB);
    // réserve changée (MemoryMax différent) : réécrit
    const other = sliceLimits(KB(16 * GiB), KB(8 * GiB), 6144)!;
    expect(dynamicLimits(other, { workBytes: 3 * GiB, availKB: KB(9 * GiB) }, applied)).toEqual({ ...other, highBytes: 6 * GiB });
  });
});
