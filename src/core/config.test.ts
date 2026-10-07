import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { DEFAULT_CONFIG, configDir, loadConfig, saveConfig, validateConfig } from './config';

const tmp = () => mkdtempSync(join(tmpdir(), 'procwatch-cfg-'));

test('configDir suit XDG_CONFIG_HOME, sinon ~/.config', () => {
  expect(configDir({ XDG_CONFIG_HOME: '/x' }, '/home/u')).toBe('/x/proc-watch');
  expect(configDir({}, '/home/u')).toBe('/home/u/.config/proc-watch');
});

test('premier lancement : crée le fichier avec les valeurs par défaut', () => {
  const dir = join(tmp(), 'proc-watch');
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

test('validateConfig rejette seuils négatifs et entrées non textuelles', () => {
  expect(validateConfig({ ...DEFAULT_CONFIG, othersThreshold: { memMB: -1, cpuPercent: 1 } })).toBeNull();
  expect(validateConfig({ ...DEFAULT_CONFIG, protected: [1] })).toBeNull();
  expect(validateConfig(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
});
