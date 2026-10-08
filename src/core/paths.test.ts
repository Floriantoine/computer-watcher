import { expect, test } from 'vitest';
import { appEventsPath, clearRequestPath, dataDir, dbPath, focusStatePath, statusPath } from './paths';

test('dataDir suit XDG_DATA_HOME, sinon ~/.local/share', () => {
  expect(dataDir({ XDG_DATA_HOME: '/d' }, '/home/u')).toBe('/d/proc-watch');
  expect(dataDir({}, '/home/u')).toBe('/home/u/.local/share/proc-watch');
});

test('fichiers du dossier de données', () => {
  expect(dbPath('/d')).toBe('/d/metrics.db');
  expect(statusPath('/d')).toBe('/d/recorder-status.json');
  expect(appEventsPath('/d')).toBe('/d/app-events.jsonl');
  expect(clearRequestPath('/d')).toBe('/d/clear-request');
});

test('état de focus : $XDG_RUNTIME_DIR/proc-watch (tmpfs de session), sinon le dossier de données', () => {
  expect(focusStatePath('/home/u/.local/share/proc-watch', { XDG_RUNTIME_DIR: '/run/user/1000' })).toBe('/run/user/1000/proc-watch/app-focus.json');
  expect(focusStatePath('/home/u/.local/share/proc-watch', {})).toBe('/home/u/.local/share/proc-watch/app-focus.json');
  expect(focusStatePath('/d', { XDG_RUNTIME_DIR: 'relatif' })).toBe('/d/app-focus.json');
});
