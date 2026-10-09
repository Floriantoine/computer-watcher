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
  expect(validateRecorderForm({ ...base, groupMinMemMB: '2000' }, true).errors.groupMinMemMB).toBe('Un nombre entre 0 et 1024 est attendu');
  expect(base.groupMinMemMB).toBe('20');
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
  ], 9);
  expect([...m]).toEqual([['a', 9]]);
});

test('leakTimes : badge retiré si la fuite n\'a pas été relancée depuis 70 min', () => {
  const M = 60_000;
  const ev = [{ ts: 0, type: 'leak', groupKey: 'a' }];
  expect(leakTimes(ev, 69 * M).has('a')).toBe(true);
  expect(leakTimes(ev, 71 * M).has('a')).toBe(false);
});

test('leakTimes : badge retiré si la mémoire a perdu plus de la moitié de la hausse', () => {
  const ev = [{ ts: 0, type: 'leak', groupKey: 'a', detail: { growthKB: 1000, memKB: 3000 } }];
  expect(leakTimes(ev, 1, () => 2600).has('a')).toBe(true);
  expect(leakTimes(ev, 1, () => 2400).has('a')).toBe(false);
  expect(leakTimes(ev, 1, () => undefined).has('a')).toBe(true); // groupe absent du snapshot : on garde
});

test('tmpfsAlertMB : dans le formulaire (4000 par défaut), entier entre 100 et 1048576', () => {
  expect(base.tmpfsAlertMB).toBe('4000');
  expect(validateRecorderForm({ ...base, tmpfsAlertMB: '99' }, true).errors.tmpfsAlertMB).toBe('Un entier entre 100 et 1048576 est attendu');
  expect(validateRecorderForm({ ...base, tmpfsAlertMB: '2.5' }, true).errors.tmpfsAlertMB).toBeTruthy();
  expect(validateRecorderForm({ ...base, tmpfsAlertMB: '4096' }, true).value?.tmpfsAlertMB).toBe(4096);
});

test('alerte disque : pourcentage (10, entier 1–50) et Go (20, entier 1–10000) dans le formulaire', () => {
  expect(base.diskAlertPercent).toBe('10');
  expect(base.diskAlertGB).toBe('20');
  expect(validateRecorderForm({ ...base, diskAlertPercent: '51' }, true).errors.diskAlertPercent).toBe('Un entier entre 1 et 50 est attendu');
  expect(validateRecorderForm({ ...base, diskAlertGB: '0' }, true).errors.diskAlertGB).toBe('Un entier entre 1 et 10000 est attendu');
  expect(validateRecorderForm({ ...base, diskAlertPercent: '15', diskAlertGB: '50' }, true).value).toMatchObject({ diskAlertPercent: 15, diskAlertGB: 50 });
});
