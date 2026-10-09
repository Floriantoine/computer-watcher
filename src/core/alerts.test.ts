import { describe, expect, test } from 'vitest';
import {
  ALERT_FLAG, alertIdFromArgv, alertMessage, appFocused, DEFAULT_ALERTS, DESKTOP_BODY_MAX, DESKTOP_TITLES, desktopAllowed, desktopMessage, desktopText,
  FOCUS_FRESH_MS, MAX_SEEN_IDS, validateAlerts, type AlertEvent,
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
    expect(a).toEqual({ channels: { ...DEFAULT_ALERTS.channels, leak: 'none' }, desktopMinIntervalMin: 10, seenUpTo: 1234, seenIds: [] });
  });

  test('seenIds : alertes fermées après seenUpTo (entiers > 0, au plus MAX_SEEN_IDS)', () => {
    expect(validateAlerts({ seenIds: [3, 9] })?.seenIds).toEqual([3, 9]);
    expect(validateAlerts({ seenIds: Array.from({ length: MAX_SEEN_IDS }, (_, i) => i + 1) })?.seenIds).toHaveLength(MAX_SEEN_IDS);
    for (const bad of [[0], [-1], [1.5], ['2'], 'x', Array.from({ length: MAX_SEEN_IDS + 1 }, (_, i) => i + 1)]) expect(validateAlerts({ seenIds: bad })).toBeNull();
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

describe('desktopMessage (texte non fiable vers notify-send)', () => {
  const nasty = '<a href="http://x">y</a> & <img src=x> &amp; \'q\'\nfin';
  const all: AlertEvent[] = [
    { id: 1, ts: 0, type: 'earlyoom_kill', groupKey: null, groupLabel: null, detail: { signal: 'SIGTERM', pid: 10, name: nasty } },
    { id: 2, ts: 0, type: 'leak', groupKey: nasty, groupLabel: nasty, detail: { growthKB: 1, memKB: 2, minutes: 60 } },
    { id: 3, ts: 0, type: 'tmpfs', groupKey: null, groupLabel: null, detail: { shmemKB: 1, thresholdKB: 1 } },
    { id: 4, ts: 0, type: 'pressure', groupKey: null, groupLabel: null, detail: { psi: 30 } },
    { id: 5, ts: 0, type: 'forecast', groupKey: null, groupLabel: null, detail: { etaMin: 3, body: nasty } },
    { id: 6, ts: 0, type: 'rule_action', groupKey: null, groupLabel: null, detail: { rule: nasty, target: nasty, result: nasty } },
    { id: 7, ts: 0, type: 'rule_dry_run', groupKey: null, groupLabel: null, detail: { rule: nasty, target: nasty } },
  ];
  test.each(all)('$type : titre fixe, corps échappé, sans caractère de contrôle, longueur bornée', (e) => {
    const m = desktopMessage(e);
    expect(m.title).toBe(`Computer Watcher — ${DESKTOP_TITLES[e.type]}`);
    expect(m.body).not.toMatch(/[<>"'\u0000-\u001f\u007f]/);
    // tout « & » est le début d'une entité
    expect(m.body.replace(/&(amp|lt|gt|quot|#39);/g, '')).not.toContain('&');
    expect(m.body.length).toBeLessThanOrEqual(DESKTOP_BODY_MAX * 6);
  });
  test('le nom reste lisible, échappé', () => {
    const m = desktopMessage(all[0]!);
    expect(m.body).toContain('&lt;a href=&quot;http://x&quot;&gt;y&lt;/a&gt; &amp; &lt;img src=x&gt; &amp;amp; &#39;q&#39; fin');
  });
  test('texte très long : coupé avant échappement (pas d’entité tronquée)', () => {
    const m = desktopMessage({ ...all[0]!, detail: { name: '&'.repeat(2000) } });
    expect(m.body.endsWith('&amp;…') || m.body.endsWith('…')).toBe(true);
    expect(m.body.replace(/&(amp|lt|gt|quot|#39);/g, '')).not.toContain('&');
  });
  test('desktopText : contrôles retirés, espaces conservés', () => {
    expect(desktopText('a\u0000b\tc\u001bd\u007fe\u2028f\u202eg')).toBe('ab cde fg');
  });
});

describe('textes des règles (⑥)', () => {
  const ev = (type: 'rule_action' | 'rule_dry_run', detail: Record<string, unknown>) => alertMessage({ id: 1, ts: 0, type, groupKey: null, groupLabel: null, detail });
  const d = { rule: 'vitest > 4 Go', target: 'vitest', memKB: 4.3 * 1024 * 1024 };
  test('action, escalade, refus, quota, simulation', () => {
    expect(ev('rule_action', { ...d, result: 'sigterm' }).title).toBe('Règle « vitest > 4 Go » : vitest arrêté (4,3 Go)');
    expect(ev('rule_action', { ...d, result: 'sigkill' }).title).toBe('Règle « vitest > 4 Go » : vitest forcé (SIGKILL)');
    expect(ev('rule_action', { ...d, result: 'refused' }).title).toBe('Règle « vitest > 4 Go » : vitest non arrêté');
    expect(ev('rule_action', { rule: 'vitest > 4 Go', result: 'quota' }).title).toBe('Règle « vitest > 4 Go » : quota atteint');
    expect(ev('rule_action', { rule: 'vitest > 4 Go', result: 'quota' }).body).toMatch(/pause pendant 1 h/);
    expect(ev('rule_dry_run', { ...d, result: 'dry_run' })).toEqual({ title: 'Simulation « vitest > 4 Go » : aurait arrêté vitest (4,3 Go)', body: 'Aucun processus touché (simulation).' });
    expect(ev('rule_dry_run', { rule: 'x', result: 'quota' }).title).toBe('Simulation « x » : quota atteint');
  });
});

describe('disk_low (disque presque plein)', () => {
  const GB = 1024 * 1024;
  const e: AlertEvent = { id: 9, ts: 0, type: 'disk_low', groupKey: null, groupLabel: null, detail: { mount: '/', availKB: 18 * GB, sizeKB: 450 * GB, thresholdKB: 45 * GB } };
  test('alerte connue, notification du bureau par défaut', () => {
    expect(DEFAULT_ALERTS.channels.disk_low).toBe('both');
    expect(DESKTOP_TITLES.disk_low).toBe('Disque presque plein');
  });
  test('texte : « Disque presque plein : / n’a plus que 18 Go libres (4 %) »', () => {
    const m = alertMessage(e);
    expect(`${m.title} : ${m.body}`).toBe('Disque presque plein : / n’a plus que 18 Go libres (4 %)');
    expect(desktopMessage(e).title).toBe('Computer Watcher — Disque presque plein');
  });
  test('détail illisible : texte générique, sans planter', () => {
    expect(alertMessage({ ...e, detail: {} }).title).toBe('Disque presque plein');
  });
});
