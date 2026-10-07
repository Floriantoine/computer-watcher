import { expect, test } from 'vitest';
import { validateConfig } from '../../core/config';
import { DEFAULT_CONFIG } from '../../core/defaults';
import { leakTimes, recorderToForm, validateRecorderForm } from './recorderForm';

const base = recorderToForm(DEFAULT_CONFIG.recorder);

test('formulaire par défaut valide, enabled conservé', () => {
  const r = validateRecorderForm(base, false);
  expect(r.errors).toEqual({});
  expect(r.value).toEqual({ ...DEFAULT_CONFIG.recorder, enabled: false });
});

test('champ vide ou hors bornes refusé avec message', () => {
  expect(validateRecorderForm({ ...base, intervalSec: '' }, true).errors.intervalSec).toBe('Valeur requise');
  expect(validateRecorderForm({ ...base, intervalSec: '61' }, true).value).toBeUndefined();
  expect(validateRecorderForm({ ...base, intervalSec: '2.5' }, true).errors.intervalSec).toBeTruthy();
  expect(validateRecorderForm({ ...base, leakMinMinutes: '4' }, true).errors.leakMinMinutes).toBeTruthy();
  expect(validateRecorderForm({ ...base, procMinCpuPercent: '-1' }, true).errors.procMinCpuPercent).toBeTruthy();
  expect(validateRecorderForm({ ...base, procMinMemMB: 'abc' }, true).errors.procMinMemMB).toBeTruthy();
});

test('accepte les décimaux pour les seuils et reste accepté par validateConfig', () => {
  const r = validateRecorderForm({ ...base, procMinCpuPercent: '0.5', intervalSec: '10' }, true);
  expect(r.value?.procMinCpuPercent).toBe(0.5);
  expect(validateConfig({ ...DEFAULT_CONFIG, recorder: r.value })).not.toBeNull();
});

test('leakTimes garde le dernier événement leak par groupe', () => {
  const m = leakTimes([
    { ts: 5, type: 'leak', groupKey: 'a' },
    { ts: 9, type: 'leak', groupKey: 'a' },
    { ts: 7, type: 'gap', groupKey: 'b' },
    { ts: 3, type: 'leak', groupKey: null },
  ]);
  expect([...m]).toEqual([['a', 9]]);
});
