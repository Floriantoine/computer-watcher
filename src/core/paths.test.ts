import { expect, test } from 'vitest';
import { appEventsPath, clearRequestPath, dataDir, dbPath, focusStatePath, statusPath } from './paths';

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
