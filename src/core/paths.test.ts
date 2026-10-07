import { expect, test } from 'vitest';
import { appEventsPath, clearRequestPath, dataDir, dbPath, statusPath } from './paths';

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
