import { expect, test } from 'vitest';
import type { RecorderStatus } from '../core/types';
import { clampToDetail, isGroupKeys, isRange, isTopOptions, recorderState } from './historyIpc';

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
