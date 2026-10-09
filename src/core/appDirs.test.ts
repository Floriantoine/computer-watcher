import { expect, test } from 'vitest';
import { appDir, legacyDir, newDir } from './appDirs';
import { APP_COMM, APP_DISPLAY_NAME, APP_NAME, APP_SELF_NAMES, LEGACY_APP_NAME } from './appName';

const fs = (paths: string[]) => (p: string) => paths.includes(p);

test('noms : affiché, technique, ancien, comm tronqué à 15 caractères', () => {
  expect(APP_DISPLAY_NAME).toBe('Computer Watcher');
  expect(APP_NAME).toBe('computer-watcher');
  expect(LEGACY_APP_NAME).toBe('proc-watch');
  expect(APP_COMM).toBe(APP_NAME.slice(0, 15));
  expect(APP_COMM).toBe('computer-watche');
  expect(APP_SELF_NAMES).toEqual(['computer-watcher', 'computer-watche', 'proc-watch']);
});

test('appDir : nouveau s’il existe, sinon ancien s’il existe, sinon nouveau', () => {
  const b = '/home/u/.config';
  expect(appDir(b, fs(['/home/u/.config/computer-watcher', '/home/u/.config/proc-watch']))).toBe('/home/u/.config/computer-watcher');
  expect(appDir(b, fs(['/home/u/.config/proc-watch']))).toBe('/home/u/.config/proc-watch');
  expect(appDir(b, fs([]))).toBe('/home/u/.config/computer-watcher');
  expect(newDir(b)).toBe('/home/u/.config/computer-watcher');
  expect(legacyDir(b)).toBe('/home/u/.config/proc-watch');
});
