import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { configDir } from './config';
import { appEventsPath, clearRequestPath, dataDir, dbPath, focusStatePath, statusPath, xdgFamilies } from './paths';

test('dataDir suit XDG_DATA_HOME, sinon ~/.local/share', () => {
  expect(dataDir({ XDG_DATA_HOME: '/d' }, '/home/u')).toBe('/d/computer-watcher');
  expect(dataDir({}, '/home/u')).toBe('/home/u/.local/share/computer-watcher');
});

test('fichiers du dossier de données', () => {
  expect(dbPath('/d')).toBe('/d/metrics.db');
  expect(statusPath('/d')).toBe('/d/recorder-status.json');
  expect(appEventsPath('/d')).toBe('/d/app-events.jsonl');
  expect(clearRequestPath('/d')).toBe('/d/clear-request');
});

test('état de focus : $XDG_RUNTIME_DIR/computer-watcher/focus-<empreinte du dossier de données>.json, sinon le dossier de données', () => {
  const real = focusStatePath('/home/u/.local/share/computer-watcher', { XDG_RUNTIME_DIR: '/run/user/1000' });
  expect(real).toMatch(/^\/run\/user\/1000\/computer-watcher\/focus-[0-9a-f]{12}\.json$/);
  // même dossier résolu → même fichier (service et app d'accord) ; autre dossier (test, mesure) → autre fichier
  expect(focusStatePath('/home/u/.local/share/computer-watcher/', { XDG_RUNTIME_DIR: '/run/user/1000' })).toBe(real);
  expect(focusStatePath('/home/u/.local/share/x/../computer-watcher', { XDG_RUNTIME_DIR: '/run/user/1000' })).toBe(real);
  expect(focusStatePath('/home/u/.cache/pw-measure-data-x/computer-watcher', { XDG_RUNTIME_DIR: '/run/user/1000' })).not.toBe(real);
  expect(focusStatePath('/home/u/.local/share/computer-watcher', {})).toBe('/home/u/.local/share/computer-watcher/app-focus.json');
  expect(focusStatePath('/d', { XDG_RUNTIME_DIR: 'relatif' })).toBe('/d/app-focus.json');
});

test('renommage : app et service résolvent les mêmes dossiers, nouveau sinon ancien (migration pas faite ou échouée)', () => {
  const base = mkdtempSync(join(homedir(), '.cache', 'pw-paths-'));
  try {
    const env = { XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config') };
    mkdirSync(join(base, 'data', 'proc-watch'), { recursive: true });
    mkdirSync(join(base, 'config', 'proc-watch'), { recursive: true });
    expect(dataDir(env, '/home/u')).toBe(join(base, 'data', 'proc-watch'));
    expect(configDir(env, '/home/u')).toBe(join(base, 'config', 'proc-watch'));
    mkdirSync(join(base, 'data', 'computer-watcher'));
    mkdirSync(join(base, 'config', 'computer-watcher'));
    expect(dataDir(env, '/home/u')).toBe(join(base, 'data', 'computer-watcher'));
    expect(configDir(env, '/home/u')).toBe(join(base, 'config', 'computer-watcher'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('revue C1 : racines XDG cohérentes seulement si toutes par défaut ou toutes définies (chemins absolus)', () => {
  expect(xdgFamilies({})).toMatchObject({ config: 'default', data: 'default', cache: 'default', consistent: true });
  expect(xdgFamilies({ XDG_CONFIG_HOME: '/a', XDG_DATA_HOME: '/b', XDG_CACHE_HOME: '/c' })).toMatchObject({ consistent: true, config: 'explicit' });
  // valeur relative = ignorée (spécification XDG) = par défaut
  expect(xdgFamilies({ XDG_CONFIG_HOME: 'rel', XDG_DATA_HOME: '', XDG_CACHE_HOME: './c' }).consistent).toBe(true);
  for (const env of [{ XDG_CONFIG_HOME: '/a' }, { XDG_DATA_HOME: '/b' }, { XDG_CACHE_HOME: '/c' }, { XDG_CONFIG_HOME: '/a', XDG_DATA_HOME: '/b' }, { XDG_CONFIG_HOME: '/a', XDG_DATA_HOME: 'rel', XDG_CACHE_HOME: '/c' }])
    expect(xdgFamilies(env).consistent, JSON.stringify(env)).toBe(false);
  // XDG_RUNTIME_DIR n'entre pas en compte (jamais déplacé)
  expect(xdgFamilies({ XDG_RUNTIME_DIR: '/run/x' }).consistent).toBe(true);
});
