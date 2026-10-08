import { describe, expect, test } from 'vitest';
import { DEFAULT_CONFIG } from '../core/config';
import type { RecorderStatus } from '../core/types';
import { applyOverride, checkConfigSet, noKill, clampToDetail, classifySetKey, isGroupKeys, isInstanceKeys, isOptionalGroupKey, isProcTreeRequest, isRange, isSinceMs, isTopOptions, recorderState } from './historyIpc';

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

test('isSinceMs : instant fini, ≥ 0 et pas dans le futur', () => {
  const now = 1_700_000_000_000;
  expect(isSinceMs(0, now)).toBe(true);
  expect(isSinceMs(now - 3600_000, now)).toBe(true);
  expect(isSinceMs(now, now)).toBe(true);
  expect(isSinceMs(now + 1, now)).toBe(false);
  for (const bad of [-1, NaN, Infinity, '5', null]) expect(isSinceMs(bad, now)).toBe(false);
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

test('isProcTreeRequest : clé de 1 à 4 096 caractères, instant fini, ≥ 0, ≤ now + 60 s', () => {
  expect(isProcTreeRequest('app:chrome', 1000, 2000)).toBe(true);
  expect(isProcTreeRequest('x'.repeat(4096), 0, 2000)).toBe(true);
  expect(isProcTreeRequest('a', 62_000, 2000)).toBe(true);
  expect(isProcTreeRequest('', 1000, 2000)).toBe(false);
  expect(isProcTreeRequest('x'.repeat(4097), 1000, 2000)).toBe(false);
  expect(isProcTreeRequest(5, 1000, 2000)).toBe(false);
  for (const bad of [NaN, -1, Infinity, '5', null]) expect(isProcTreeRequest('a', bad, 2000)).toBe(false);
  expect(isProcTreeRequest('a', 2000 + 61_000, 2000)).toBe(false);
});

test('isOptionalGroupKey : absent, ou clé de 1 à 4 096 caractères', () => {
  for (const ok of [undefined, 'a', 'x'.repeat(4096)]) expect(isOptionalGroupKey(ok)).toBe(true);
  for (const bad of ['', 'x'.repeat(4097), 3, null, {}, ['a']]) expect(isOptionalGroupKey(bad)).toBe(false);
});

describe('config:set et règles (⑥)', () => {
  const rule = {
    id: 'r-a', name: 'vitest', enabled: true, mode: 'simulate' as const, createdAt: 1,
    condition: { kind: 'memory' as const, target: 'instance' as const, match: { by: 'name' as const, value: 'vitest' }, overMB: 4096, forMin: 5 },
  };
  const current = { ...DEFAULT_CONFIG, rules: { enabled: true, list: [rule] } };

  test('nouvelle règle active → rejet, message « démarre en Simulation »', () => {
    const next = { ...current, rules: { enabled: true, list: [rule, { ...rule, id: 'r-b', mode: 'active' }] } };
    expect(() => checkConfigSet(next, current)).toThrow(/^Une nouvelle règle démarre en Simulation/);
  });
  test('règle existante passée en Active (après 10 min de Simulation) → acceptée', () => {
    const next = { ...current, rules: { enabled: true, list: [{ ...rule, mode: 'active' }] } };
    const simulated = { ...current, rules: { enabled: true, list: [{ ...rule, simulatedSince: 0 }] } };
    expect(checkConfigSet(next, simulated, 3600_000).rules.list[0]!.mode).toBe('active');
  });
  test('règle invalide envoyée par le renderer → tout est refusé (strict), avec le nom de la règle', () => {
    const next = { ...current, rules: { enabled: true, list: [rule, { ...rule, id: 'r-c', name: 'cassée', condition: { ...rule.condition, overMB: 1 } }] } };
    expect(() => checkConfigSet(next, current)).toThrow(/^Règle « cassée » invalide : seuil/);
  });
  test('config invalide → « Configuration invalide »', () => {
    expect(() => checkConfigSet({ version: 2 }, current)).toThrow('Configuration invalide');
  });
  test('PROC_WATCH_NO_KILL=1 → noKill', () => {
    expect(noKill({ PROC_WATCH_NO_KILL: '1' })).toBe(true);
    expect(noKill({})).toBe(false);
  });
});

describe('M-3 : 10 min de Simulation avant Active, simulatedSince tenu par le main', () => {
  const NOW = 10 * 3600_000;
  const rule = {
    id: 'r-a', name: 'vitest', enabled: true, mode: 'simulate' as const, createdAt: 1,
    condition: { kind: 'memory' as const, target: 'instance' as const, match: { by: 'name' as const, value: 'vitest' }, overMB: 4096, forMin: 5 },
  };
  const cfg = (r: object) => ({ ...DEFAULT_CONFIG, rules: { enabled: true, list: [r] } }) as never;
  test('en Simulation depuis 5 min → refus (« encore 5 min ») ; depuis 10 min → accepté', () => {
    expect(() => checkConfigSet(cfg({ ...rule, mode: 'active' }), cfg({ ...rule, simulatedSince: NOW - 5 * 60_000 }), NOW)).toThrow(/Au moins 10 min en Simulation.*encore 5 min/);
    expect(checkConfigSet(cfg({ ...rule, mode: 'active' }), cfg({ ...rule, simulatedSince: NOW - 10 * 60_000 }), NOW).rules.list[0]!.mode).toBe('active');
  });
  test('sans début de simulation connu → refus', () => {
    expect(() => checkConfigSet(cfg({ ...rule, mode: 'active' }), cfg(rule), NOW)).toThrow(/Au moins 10 min/);
  });
  test('le renderer ne peut pas antidater simulatedSince : le main le réécrit', () => {
    const saved = checkConfigSet(cfg({ ...rule, simulatedSince: 0 }), cfg({ ...rule, simulatedSince: NOW - 60_000 }), NOW);
    expect(saved.rules.list[0]!.simulatedSince).toBe(NOW - 60_000);
    const fresh = checkConfigSet({ ...DEFAULT_CONFIG, rules: { enabled: true, list: [{ ...rule, id: 'r-new', simulatedSince: 0 }] } }, cfg(rule), NOW);
    expect(fresh.rules.list[0]!.simulatedSince).toBe(NOW);
  });
  test('condition changée ou retour en Simulation → la Simulation repart', () => {
    const changed = checkConfigSet(cfg({ ...rule, condition: { ...rule.condition, overMB: 200 } }), cfg({ ...rule, simulatedSince: 0 }), NOW);
    expect(changed.rules.list[0]!.simulatedSince).toBe(NOW);
    const back = checkConfigSet(cfg({ ...rule, mode: 'simulate' }), cfg({ ...rule, mode: 'active', simulatedSince: 0 }), NOW);
    expect(back.rules.list[0]!.simulatedSince).toBe(NOW);
    const kept = checkConfigSet(cfg({ ...rule, mode: 'active', name: 'autre' }), cfg({ ...rule, mode: 'active', simulatedSince: 7 }), NOW);
    expect(kept.rules.list[0]!.simulatedSince).toBe(7);
  });
});
