import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { takeFridgeRequests } from '../core/antigel/fridgeRequest';
import { sampleState } from '../core/antigel/testFixtures';
import { antigelStatePath } from '../core/paths';
import { requestFridge } from './fridgeIpc';

let dir: string;
const NOW = 1_000_000;
beforeEach(() => {
  mkdirSync(join(homedir(), '.cache'), { recursive: true });
  dir = mkdtempSync(join(homedir(), '.cache', 'pw-fridge-ipc-'));
  writeFileSync(antigelStatePath(dir), JSON.stringify(sampleState({ at: NOW })));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('projet plafonné : demande déposée (racine tirée de l’identifiant du groupe)', () => {
  expect(requestFridge(dir, NOW, 5, 'project:/home/u/alpha', 'freeze')).toEqual({ queued: true });
  expect(takeFridgeRequests(dir, NOW)).toEqual([{ root: '/home/u/alpha', action: 'freeze', at: NOW }]);
});

test('refus : action, identifiant, projet hors plafond, état périmé ou éteint', () => {
  for (const [id, a] of [['project:/home/u/alpha', 'kill'], ['project:/home/u/alpha', undefined], ['app:warp', 'freeze'], ['project:/', 'freeze'],
    ['project:home/u', 'freeze'], ['project:/home/u/../x', 'thaw'], [42, 'thaw'], ['/home/u/alpha', 'freeze']] as [unknown, unknown][]) {
    expect(() => requestFridge(dir, NOW, 5, id, a), `${String(id)} ${String(a)}`).toThrow();
  }
  expect(() => requestFridge(dir, NOW, 5, 'project:/home/u/beta', 'freeze')).toThrow(/sous le plafond/);
  expect(() => requestFridge(dir, NOW + 60_000, 5, 'project:/home/u/alpha', 'freeze')).toThrow(/arrêté/);
  writeFileSync(antigelStatePath(dir), JSON.stringify(sampleState({ at: NOW, enabled: false, status: 'off' })));
  expect(() => requestFridge(dir, NOW, 5, 'project:/home/u/alpha', 'freeze')).toThrow(/inactif/);
  expect(takeFridgeRequests(dir, NOW)).toEqual([]);
});

test('réveiller : toujours permis, même service arrêté', () => {
  rmSync(antigelStatePath(dir));
  requestFridge(dir, NOW, 5, 'project:/home/u/beta', 'thaw');
  expect(takeFridgeRequests(dir, NOW)).toEqual([{ root: '/home/u/beta', action: 'thaw', at: NOW }]);
});
