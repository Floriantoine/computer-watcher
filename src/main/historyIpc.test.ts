import { expect, test } from 'vitest';
import type { RecorderStatus } from '../core/types';
import { applyOverride, clampToDetail, classifySetKey, isGroupKeys, isInstanceKeys, isRange, isSinceMs, isTopOptions, recorderState } from './historyIpc';

test('isRange : préréglages et plages valides uniquement', () => {
  for (const ok of ['1h', '6h', '24h', '7d', '30d', { from: 0, to: 10 }]) expect(isRange(ok)).toBe(true);
  for (const bad of ['2h', '', null, undefined, 5, {}, { from: 0 }, { from: 'a', to: 1 }, { from: NaN, to: 1 }, { from: 0, to: Infinity }]) expect(isRange(bad)).toBe(false);
});

const status = (lastSampleAt: number | null): RecorderStatus => ({ pid: 1, startedAt: 0, lastSampleAt, lastError: null, earlyoomSource: 'ok', dbSizeBytes: 0 });
const base = { available: true, enabled: true, intervalSec: 5, now: 100_000 };

test('recorderState : running selon lastSampleAt (3 intervalles + 2 s)', () => {
  expect(recorderState({ ...base, status: null }).running).toBe(false);
  expect(recorderState({ ...base, status: status(null) }).running).toBe(false);
  expect(recorderState({ ...base, status: status(100_000 - 16_999) }).running).toBe(true);
  expect(recorderState({ ...base, status: status(100_000 - 17_000) }).running).toBe(false);
  const s = status(99_000);
  expect(recorderState({ ...base, available: false, enabled: false, status: s })).toEqual({ available: false, enabled: false, running: true, status: s });
});

test('isTopOptions : absent, ou limit / peakLimit entiers 1..50', () => {
  for (const ok of [undefined, {}, { limit: 50 }, { peakLimit: 8 }, { limit: 10, peakLimit: 1 }]) expect(isTopOptions(ok)).toBe(true);
  for (const bad of [null, 'max', { limit: 0 }, { limit: 51 }, { limit: 2.5 }, { limit: '8' }, { peakLimit: 0 }, { peakLimit: 51 }]) expect(isTopOptions(bad)).toBe(false);
});

test('isGroupKeys : absent, ou 1 à 50 clés texte', () => {
  for (const ok of [undefined, ['a'], Array.from({ length: 50 }, (_, i) => `k${i}`)]) expect(isGroupKeys(ok)).toBe(true);
  for (const bad of [[], Array.from({ length: 51 }, (_, i) => `k${i}`), [1], 'a', null, {}]) expect(isGroupKeys(bad)).toBe(false);
});

test('clampToDetail : plage ramenée aux detailHours dernières heures', () => {
  const H = 3600_000;
  expect(clampToDetail({ from: 0, to: 100 * H }, 100 * H, 24)).toEqual({ from: 76 * H, to: 100 * H });
  expect(clampToDetail({ from: 90 * H, to: 95 * H }, 100 * H, 24)).toEqual({ from: 90 * H, to: 95 * H });
  expect(clampToDetail({ from: 0, to: 10 * H }, 100 * H, 24)).toEqual({ from: 76 * H, to: 76 * H }); // entièrement hors détail : vide
});

test('isInstanceKeys : 1 à 200 clés texte non vides et bornées', () => {
  expect(isInstanceKeys(['a#1:2'])).toBe(true);
  expect(isInstanceKeys(Array.from({ length: 200 }, (_, i) => `k${i}`))).toBe(true);
  for (const bad of [[], Array.from({ length: 201 }, (_, i) => `k${i}`), [''], [3], 'a', null, undefined, ['x'.repeat(4097)]]) expect(isInstanceKeys(bad)).toBe(false);
});

test('isSinceMs : instant fini ≥ 0', () => {
  expect(isSinceMs(0)).toBe(true);
  expect(isSinceMs(1_700_000_000_000)).toBe(true);
  for (const bad of [-1, NaN, Infinity, '5', null]) expect(isSinceMs(bad)).toBe(false);
});

test('classifySetKey : portée et signature texte de 1 à 300 caractères, catégorie connue ou null', () => {
  expect(classifySetKey('/home/u/acme', 'vite', 'back')).toEqual({ key: '/home/u/acme|vite', category: 'back' });
  expect(classifySetKey('app:chrome', 'chrome', null)).toEqual({ key: 'app:chrome|chrome', category: null });
  expect(classifySetKey('/a', 'vite', 'serveur')).toBeNull();
  expect(classifySetKey('/a', 'vite', undefined)).toBeNull();
  expect(classifySetKey('', 'vite', 'front')).toBeNull();
  expect(classifySetKey('/a', '', 'front')).toBeNull();
  expect(classifySetKey(3, 'vite', 'front')).toBeNull();
  expect(classifySetKey('x'.repeat(301), 'vite', 'front')).toBeNull();
  expect(classifySetKey('/a', 'x'.repeat(301), 'front')).toBeNull();
  // la clé complète doit rester une clé de config valide (≤ 300)
  expect(classifySetKey('x'.repeat(200), 'y'.repeat(100), 'front')).toBeNull();
  expect(classifySetKey('x'.repeat(200), 'y'.repeat(99), 'front')).not.toBeNull();
});

test('applyOverride : ajoute, remplace, retire ; refuse une 501e correction', () => {
  expect(applyOverride({}, 'k', 'front')).toEqual({ k: 'front' });
  expect(applyOverride({ k: 'front' }, 'k', 'back')).toEqual({ k: 'back' });
  expect(applyOverride({ k: 'front', j: 'db' }, 'k', null)).toEqual({ j: 'db' });
  const full = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, 'front' as const]));
  expect(applyOverride(full, 'nouvelle', 'back')).toBeNull();
  expect(applyOverride(full, 'k1', 'back')).toMatchObject({ k1: 'back' });
  expect(applyOverride(full, 'k1', null)).not.toBeNull();
});
