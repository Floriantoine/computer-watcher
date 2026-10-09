import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { userDataPath } from './userDataPath';

// Racines temporaires sous ~/.cache/pw-userdata-* (jamais les vrais dossiers), retirées à la fin.
const base = mkdtempSync(join(homedir(), '.cache', 'pw-userdata-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

test('userData : nouveau dossier (rien d’ancien, ou migration faite), sinon l’ancien (migration pas faite ou échouée)', () => {
  const cfg = join(base, 'a');
  mkdirSync(cfg);
  expect(userDataPath({ XDG_CONFIG_HOME: cfg }, '/home/u')).toBe(join(cfg, 'computer-watcher'));
  mkdirSync(join(cfg, 'proc-watch'));
  expect(userDataPath({ XDG_CONFIG_HOME: cfg }, '/home/u')).toBe(join(cfg, 'proc-watch'));
  mkdirSync(join(cfg, 'computer-watcher'));
  expect(userDataPath({ XDG_CONFIG_HOME: cfg }, '/home/u')).toBe(join(cfg, 'computer-watcher'));
  expect(userDataPath({}, '/home/u')).toBe('/home/u/.config/computer-watcher');
});

test('userData : jamais d’espace ni de majuscule dans le nom (le nom affiché n’est pas un nom de dossier)', () => {
  const name = userDataPath({}, '/home/u').split('/').at(-1)!;
  expect(name).not.toMatch(/[\sA-Z]/);
});
