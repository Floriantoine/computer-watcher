import { describe, expect, test } from 'vitest';
import {
  ALERT_FLAG, alertIdFromArgv, alertMessage, appFocused, DEFAULT_ALERTS, desktopAllowed, FOCUS_FRESH_MS, validateAlerts, type AlertEvent,
} from './alerts';
import { DEFAULT_CONFIG, validateConfig } from './config';

const base = { version: 1, protected: [], othersThreshold: { memMB: 100, cpuPercent: 1 } };

describe('validateAlerts / config', () => {
  test('une config sans `alerts` reste valide (défauts, seenUpTo 0 = à initialiser)', () => {
    const c = validateConfig(base);
    expect(c).not.toBeNull();
    expect(c!.alerts).toEqual(DEFAULT_ALERTS);
    expect(c!.alerts.seenUpTo).toBe(0);
  });

  test('défauts : earlyoom_kill, leak, tmpfs, forecast → both ; pressure → popup ; 5 min', () => {
    expect(DEFAULT_ALERTS.channels).toMatchObject({ earlyoom_kill: 'both', leak: 'both', tmpfs: 'both', forecast: 'both', pressure: 'popup' });
    expect(DEFAULT_ALERTS.desktopMinIntervalMin).toBe(5);
    expect(DEFAULT_CONFIG.alerts).toEqual(DEFAULT_ALERTS);
  });

  test('canaux partiels : les types absents prennent leur défaut, les clés inconnues sont ignorées', () => {
    const a = validateAlerts({ channels: { leak: 'none', bogus: 'both' }, desktopMinIntervalMin: 10, seenUpTo: 1234 });
    expect(a).toEqual({ channels: { ...DEFAULT_ALERTS.channels, leak: 'none' }, desktopMinIntervalMin: 10, seenUpTo: 1234 });
  });

  test.each([
    ['canal inconnu', { channels: { leak: 'loud' } }],
    ['channels non objet', { channels: [] }],
    ['intervalle 0', { desktopMinIntervalMin: 0 }],
    ['intervalle 121', { desktopMinIntervalMin: 121 }],
    ['intervalle décimal', { desktopMinIntervalMin: 2.5 }],
    ['intervalle texte', { desktopMinIntervalMin: '5' }],
    ['seenUpTo négatif', { seenUpTo: -1 }],
    ['seenUpTo NaN', { seenUpTo: Number.NaN }],
    ['alerts null', null],
  ])('invalide : %s', (_l, alerts) => {
    expect(validateAlerts(alerts)).toBeNull();
    expect(validateConfig({ ...base, alerts })).toBeNull();
  });

  test('bornes 1 et 120 acceptées', () => {
    expect(validateAlerts({ desktopMinIntervalMin: 1 })?.desktopMinIntervalMin).toBe(1);
    expect(validateAlerts({ desktopMinIntervalMin: 120 })?.desktopMinIntervalMin).toBe(120);
  });
});

describe('anti-spam', () => {
  test('au plus une notification bureau par type par intervalle (fausse horloge)', () => {
    const last = new Map<string, number>();
    let t = 1_000_000;
    expect(desktopAllowed(last, 'leak', t, 5)).toBe(true);
    last.set('leak', t);
    t += 5 * 60_000 - 1;
    expect(desktopAllowed(last, 'leak', t, 5)).toBe(false);
    expect(desktopAllowed(last, 'tmpfs', t, 5)).toBe(true); // autre type : indépendant
    t += 1;
    expect(desktopAllowed(last, 'leak', t, 5)).toBe(true);
  });

  test('horloge qui recule : autorisé (pas de blocage indéfini)', () => {
    const last = new Map([['leak', 2_000_000]]);
    expect(desktopAllowed(last, 'leak', 1_000_000, 5)).toBe(true);
  });
});

describe('app au premier plan', () => {
  test('état frais (< 10 s) et focalisé → premier plan', () => {
    expect(appFocused({ focused: true, ts: 1000 }, 1000 + FOCUS_FRESH_MS - 1)).toBe(true);
    expect(appFocused({ focused: true, ts: 1000 }, 1000 + FOCUS_FRESH_MS)).toBe(false);
    expect(appFocused({ focused: false, ts: 1000 }, 1001)).toBe(false);
    expect(appFocused(null, 1001)).toBe(false);
    expect(appFocused({ focused: true, ts: 5000 }, 1000)).toBe(false); // futur : ignoré
  });
});

describe('--alert=<id>', () => {
  test.each([
    [['/x/electron', '/x', `${ALERT_FLAG}42`], 42],
    [['/x/electron', '/x'], null],
    [['--alert=abc'], null],
    [['--alert=-3'], null],
    [['--alert='], null],
    [['--alert=7', '--alert=9'], 9],
  ])('%j → %s', (argv, id) => {
    expect(alertIdFromArgv(argv)).toBe(id);
  });
});

describe('alertMessage', () => {
  const ev = (type: AlertEvent['type'], detail: Record<string, unknown>, groupLabel: string | null = null): AlertEvent =>
    ({ id: 1, ts: 0, type, groupKey: null, groupLabel, detail });
  test.each([
    [ev('earlyoom_kill', { signal: 'SIGTERM', pid: 10, name: 'chrome' }), 'earlyoom a arrêté chrome', 'SIGTERM envoyé au processus 10'],
    [ev('leak', { growthKB: 3 * 1024 * 1024, memKB: 5 * 1024 * 1024, minutes: 60 }, 'acme'), 'Fuite probable : acme', '+3,0 Go en 60 min (5,0 Go au total)'],
    [ev('tmpfs', { shmemKB: 3 * 1024 * 1024, thresholdKB: 2 * 1024 * 1024 }), 'Fichiers en mémoire : 3,0 Go', 'Au-dessus du seuil de 2,0 Go (/tmp, mémoire partagée)'],
    [ev('pressure', { psi: 31.6 }), 'Pression mémoire 32 %', 'Le système attend la mémoire'],
    [ev('forecast', { etaMin: 7.6 }), 'Mémoire épuisée dans ~8 min', ''],
  ])('%#', (e, title, body) => {
    const m = alertMessage(e);
    expect(m.title).toBe(title);
    expect(m.body).toContain(body);
  });
});
