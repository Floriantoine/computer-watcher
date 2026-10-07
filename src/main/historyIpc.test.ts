import { expect, test } from 'vitest';
import type { RecorderStatus } from '../core/types';
import { isRange, recorderState } from './historyIpc';

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
