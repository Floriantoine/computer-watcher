import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { DEFAULT_CONFIG, configDir, loadConfig, saveConfig, validateConfig } from './config';
import { DEFAULT_RECORDER } from './defaults';

const tmp = () => mkdtempSync(join(tmpdir(), 'procwatch-cfg-'));

test('configDir suit XDG_CONFIG_HOME, sinon ~/.config', () => {
  expect(configDir({ XDG_CONFIG_HOME: '/x' }, '/home/u')).toBe('/x/computer-watcher');
  expect(configDir({}, '/home/u')).toBe('/home/u/.config/computer-watcher');
});

test('premier lancement : crée le fichier avec les valeurs par défaut', () => {
  const dir = join(tmp(), 'computer-watcher');
  const r = loadConfig(dir);
  expect(r).toEqual({ config: DEFAULT_CONFIG, warning: null });
  expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))).toEqual(DEFAULT_CONFIG);
});

test('relit ce qui a été sauvegardé', () => {
  const dir = tmp();
  const cfg = { ...DEFAULT_CONFIG, protected: ['zsh', 'mon-app'] };
  saveConfig(dir, cfg);
  expect(loadConfig(dir).config).toEqual(cfg);
});

test('JSON corrompu → .bak, défauts, avertissement', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'config.json'), '{ pas du json');
  const r = loadConfig(dir);
  expect(r.config).toEqual(DEFAULT_CONFIG);
  expect(r.warning).toMatch(/config\.json\.bak/);
  expect(readFileSync(join(dir, 'config.json.bak'), 'utf8')).toBe('{ pas du json');
});

test('JSON valide mais structure fausse → traité comme corrompu', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 1, protected: 'zsh' }));
  expect(loadConfig(dir).warning).not.toBeNull();
});

test('fichier illisible → défauts et avertissement, sans écraser le fichier', () => {
  if (process.getuid?.() === 0) return; // root lit tout
  const dir = tmp();
  writeFileSync(join(dir, 'config.json'), JSON.stringify(DEFAULT_CONFIG));
  chmodSync(join(dir, 'config.json'), 0o000);
  const r = loadConfig(dir);
  expect(r.config).toEqual(DEFAULT_CONFIG);
  expect(r.warning).toMatch(/illisible/);
  expect(existsSync(join(dir, 'config.json.bak'))).toBe(false);
});

test('écriture atomique : aucun fichier temporaire ne reste', () => {
  const dir = tmp();
  saveConfig(dir, DEFAULT_CONFIG);
  expect(readdirSync(dir)).toEqual(['config.json']);
});

test('premier lancement en dossier illisible → défauts et avertissement, sans crash', () => {
  if (process.getuid?.() === 0) return; // root écrit partout
  const parent = tmp();
  const dir = join(parent, 'computer-watcher');
  chmodSync(parent, 0o500);
  const r = loadConfig(dir);
  expect(r.config).toEqual(DEFAULT_CONFIG);
  expect(r.warning).not.toBeNull();
  expect(r.warning).toMatch(/Impossible d'écrire/);
  chmodSync(parent, 0o755); // cleanup pour teardown
});

test('fichier invalide en dossier illisible → défauts et avertissement, sans crash', () => {
  if (process.getuid?.() === 0) return; // root écrit partout
  const dir = tmp();
  writeFileSync(join(dir, 'config.json'), '{ pas du json');
  chmodSync(dir, 0o500);
  const r = loadConfig(dir);
  expect(r.config).toEqual(DEFAULT_CONFIG);
  expect(r.warning).not.toBeNull();
  expect(r.warning).toMatch(/Impossible d'écrire/);
  chmodSync(dir, 0o755); // cleanup pour teardown
});

test('validateConfig rejette seuils négatifs et entrées non textuelles', () => {
  expect(validateConfig({ ...DEFAULT_CONFIG, othersThreshold: { memMB: -1, cpuPercent: 1 } })).toBeNull();
  expect(validateConfig({ ...DEFAULT_CONFIG, protected: [1] })).toBeNull();
  expect(validateConfig(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
});

test('config v1 sans section recorder : valide, défauts ajoutés', () => {
  const { recorder: _r, ...v1 } = DEFAULT_CONFIG;
  expect(validateConfig(v1)).toEqual({ ...v1, recorder: DEFAULT_RECORDER });
});

test('config v1 existante sur disque sans recorder : relue sans .bak ni avertissement', () => {
  const dir = tmp();
  const { recorder: _r, ...v1 } = DEFAULT_CONFIG;
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...v1, protected: ['zsh'] }));
  const r = loadConfig(dir);
  expect(r.warning).toBeNull();
  expect(r.config.protected).toEqual(['zsh']);
  expect(r.config.recorder).toEqual(DEFAULT_RECORDER);
  expect(existsSync(join(dir, 'config.json.bak'))).toBe(false);
});

test.each([
  ['intervalSec', 0], ['intervalSec', 61], ['intervalSec', 2.5],
  ['detailHours', 0], ['detailHours', 169],
  ['summaryDays', 0], ['summaryDays', 366],
  ['procMinMemMB', -1], ['procMinCpuPercent', -1],
  ['leakMinMinutes', 4], ['leakMinGrowthMB', -1],
  ['groupMinMemMB', -1], ['groupMinMemMB', 1025], ['groupMinMemMB', 'x'],
  ['enabled', 'oui'],
])('recorder.%s = %s → config invalide', (key, value) => {
  expect(validateConfig({ ...DEFAULT_CONFIG, recorder: { ...DEFAULT_RECORDER, [key]: value } })).toBeNull();
});

test('recorder valide modifié : conservé', () => {
  const recorder = { ...DEFAULT_RECORDER, intervalSec: 10, enabled: false };
  expect(validateConfig({ ...DEFAULT_CONFIG, recorder })?.recorder).toEqual(recorder);
});

test('recorder.groupMinMemMB : 20 Mo par défaut, ajouté si absent (config d\'une version précédente)', () => {
  expect(DEFAULT_RECORDER.groupMinMemMB).toBe(20);
  const { groupMinMemMB: _g, ...old } = DEFAULT_RECORDER;
  expect(validateConfig({ ...DEFAULT_CONFIG, recorder: { ...old, intervalSec: 10 } })?.recorder).toEqual({ ...DEFAULT_RECORDER, intervalSec: 10 });
  expect(validateConfig({ ...DEFAULT_CONFIG, recorder: { ...DEFAULT_RECORDER, groupMinMemMB: 0 } })?.recorder.groupMinMemMB).toBe(0);
  expect(validateConfig({ ...DEFAULT_CONFIG, recorder: { ...DEFAULT_RECORDER, groupMinMemMB: 1024 } })?.recorder.groupMinMemMB).toBe(1024);
});

describe('section ui', () => {
  test('par défaut : effets visuels complets, mémoire en RSS', () => {
    expect(DEFAULT_CONFIG.ui).toEqual({ reducedEffects: false, memoryMetric: 'rss', trayIcon: true, closeToTray: true, swapSleepMinMB: 100 });
  });
  test('config sans section ui : valide, défaut ajouté', () => {
    const { ui: _u, ...old } = DEFAULT_CONFIG;
    expect(validateConfig(old)?.ui).toEqual({ reducedEffects: false, memoryMetric: 'rss', trayIcon: true, closeToTray: true, swapSleepMinMB: 100 });
  });
  test('reducedEffects conservé ; ui sans memoryMetric (config existante) → rss', () => {
    expect(validateConfig({ ...DEFAULT_CONFIG, ui: { reducedEffects: true } })?.ui).toEqual({ ...DEFAULT_CONFIG.ui, reducedEffects: true, memoryMetric: 'rss' });
  });
  test('memoryMetric « pss » conservé', () => {
    expect(validateConfig({ ...DEFAULT_CONFIG, ui: { reducedEffects: false, memoryMetric: 'pss' } })?.ui).toEqual({ ...DEFAULT_CONFIG.ui, memoryMetric: 'pss' });
  });
  test.each([['PSS'], [1], [null], ['']])('memoryMetric = %j → config invalide', (memoryMetric) => {
    expect(validateConfig({ ...DEFAULT_CONFIG, ui: { reducedEffects: false, memoryMetric } })).toBeNull();
  });
  test.each([[null], ['oui'], [{}], [{ reducedEffects: 'true' }]])('ui = %j → config invalide', (ui) => {
    expect(validateConfig({ ...DEFAULT_CONFIG, ui })).toBeNull();
  });
});

describe('ui : barre des tâches et swap endormi', () => {
  test('config existante sans ces champs → icône et fermeture vers la barre activées, 100 Mo', () => {
    const ui = validateConfig({ ...DEFAULT_CONFIG, ui: { reducedEffects: false, memoryMetric: 'pss' } })?.ui;
    expect(ui).toEqual({ reducedEffects: false, memoryMetric: 'pss', trayIcon: true, closeToTray: true, swapSleepMinMB: 100 });
  });
  test('valeurs conservées', () => {
    const ui = { ...DEFAULT_CONFIG.ui, trayIcon: false, closeToTray: false, swapSleepMinMB: 65_536 };
    expect(validateConfig({ ...DEFAULT_CONFIG, ui })?.ui).toEqual(ui);
  });
  test.each<[string, unknown]>([
    ['closeToTray', 'oui'], ['trayIcon', 1], ['trayIcon', null], ['swapSleepMinMB', 0], ['swapSleepMinMB', 65_537], ['swapSleepMinMB', 1.5], ['swapSleepMinMB', '100'],
  ])('%s = %j → config invalide', (field, value) => {
    expect(validateConfig({ ...DEFAULT_CONFIG, ui: { ...DEFAULT_CONFIG.ui, [field]: value } })).toBeNull();
  });
});

test('config sans classify : défauts', () => {
  const { classify: _c, ...old } = DEFAULT_CONFIG;
  expect(validateConfig(old)?.classify).toEqual({ detectPorts: true, overrides: {} });
});

test('classify : overrides valides conservés', () => {
  const classify = { detectPorts: false, overrides: { '/a|node vite': 'front', 'g|x': 'db' } };
  expect(validateConfig({ ...DEFAULT_CONFIG, classify })?.classify).toEqual(classify);
});

test.each<[string, unknown]>([
  ['catégorie inconnue', { detectPorts: true, overrides: { a: 'nope' } }],
  ['> 500 entrées', { detectPorts: true, overrides: Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`k${i}`, 'front'])) }],
  ['clé > 300 caractères', { detectPorts: true, overrides: { ['k'.repeat(301)]: 'front' } }],
  ['detectPorts non booléen', { detectPorts: 'yes', overrides: {} }],
  ['overrides absent', { detectPorts: true }],
])('classify invalide (%s) → config invalide', (_n, classify) => {
  expect(validateConfig({ ...DEFAULT_CONFIG, classify })).toBeNull();
});

test('recorder.tmpfsAlertMB : 4000 Mo par défaut, ajouté si absent, bornes 100 à 1 048 576, entier', () => {
  expect(DEFAULT_RECORDER.tmpfsAlertMB).toBe(4000);
  const { tmpfsAlertMB: _t, ...old } = DEFAULT_RECORDER;
  expect(validateConfig({ ...DEFAULT_CONFIG, recorder: old })?.recorder.tmpfsAlertMB).toBe(4000);
  expect(validateConfig({ ...DEFAULT_CONFIG, recorder: { ...DEFAULT_RECORDER, tmpfsAlertMB: 100 } })?.recorder.tmpfsAlertMB).toBe(100);
  expect(validateConfig({ ...DEFAULT_CONFIG, recorder: { ...DEFAULT_RECORDER, tmpfsAlertMB: 1_048_576 } })?.recorder.tmpfsAlertMB).toBe(1_048_576);
  for (const bad of [99, 1_048_577, 2.5, 'x']) {
    expect(validateConfig({ ...DEFAULT_CONFIG, recorder: { ...DEFAULT_RECORDER, tmpfsAlertMB: bad } }), String(bad)).toBeNull();
  }
});

describe('règles (⑥)', () => {
  test('config v1 existante sans « rules » → valide, règles éteintes, liste vide', () => {
    const { rules: _r, ...old } = { ...DEFAULT_CONFIG, rules: undefined };
    const c = validateConfig(old);
    expect(c).not.toBeNull();
    expect(c!.rules).toEqual({ enabled: false, list: [] });
    expect(DEFAULT_CONFIG.rules).toEqual({ enabled: false, list: [] });
  });

  test('une règle invalide écrite à la main → seule cette règle ignorée, erreur visible, reste de la config gardé', () => {
    const dir = tmp();
    const good = { id: 'r-ok', name: 'ok', enabled: true, mode: 'simulate', createdAt: 1, condition: { kind: 'forecast', underMin: 3, includeApps: [] } };
    const bad = { ...good, id: 'r-bad', name: 'cassée', condition: { kind: 'forecast', underMin: 99, includeApps: [] } };
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...DEFAULT_CONFIG, protected: ['x'], rules: { enabled: true, list: [bad, good] } }));
    const r = loadConfig(dir);
    expect(r.warning).toBeNull();
    expect(r.config.protected).toEqual(['x']);
    expect(r.config.rules).toEqual({ enabled: true, list: [good] });
    expect(r.ruleIssues).toEqual([{ index: 0, id: 'r-bad', name: 'cassée', error: expect.stringMatching(/délai/) }]);
    expect(existsSync(join(dir, 'config.json.bak'))).toBe(false);
  });
});

describe('rappel earlyoom (« Ne plus rappeler pendant 7 jours »)', () => {
  test('absent par défaut, config existante sans le champ → valide, toujours absent', () => {
    expect(DEFAULT_CONFIG.earlyoomReminder).toBeUndefined();
    const c = validateConfig(structuredClone(DEFAULT_CONFIG));
    expect(c).not.toBeNull();
    expect(c && 'earlyoomReminder' in c).toBe(false);
  });
  test('horodatage conservé', () => {
    expect(validateConfig({ ...structuredClone(DEFAULT_CONFIG), earlyoomReminder: { snoozedAt: 1_800_000_000_000 } })?.earlyoomReminder).toEqual({ snoozedAt: 1_800_000_000_000 });
  });
  test.each([null, 'x', { snoozedAt: -1 }, { snoozedAt: 'demain' }, { snoozedAt: 1.5 }])('%j → champ ignoré, reste de la config gardé', (v) => {
    const c = validateConfig({ ...structuredClone(DEFAULT_CONFIG), protected: ['acme'], earlyoomReminder: v });
    expect(c?.protected).toEqual(['acme']);
    expect(c && 'earlyoomReminder' in c).toBe(false);
  });
});

test('M-2 : XDG_CONFIG_HOME relatif ignoré', async () => {
  const { configDir } = await import('./config');
  expect(configDir({ XDG_CONFIG_HOME: 'rel' }, '/home/u')).toBe('/home/u/.config/computer-watcher');
});
