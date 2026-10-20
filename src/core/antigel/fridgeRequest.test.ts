import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { REQUEST_MAX_AGE_MS, fridgeRequestPath, takeFridgeRequests, writeFridgeRequest } from './fridgeRequest';

let dir: string;
beforeEach(() => {
  mkdirSync(join(homedir(), '.cache'), { recursive: true });
  dir = mkdtempSync(join(homedir(), '.cache', 'pw-fridge-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('écrite en 0600 par le main, fusionnée par racine, prise une seule fois par le service', () => {
  writeFridgeRequest(dir, { root: '/home/u/alpha', action: 'freeze', at: 1000 });
  writeFridgeRequest(dir, { root: '/home/u/beta', action: 'freeze', at: 1001 });
  writeFridgeRequest(dir, { root: '/home/u/alpha', action: 'thaw', at: 1002 });
  expect(statSync(fridgeRequestPath(dir)).mode & 0o777).toBe(0o600);
  expect(takeFridgeRequests(dir, 1500)).toEqual([
    { root: '/home/u/beta', action: 'freeze', at: 1001 }, { root: '/home/u/alpha', action: 'thaw', at: 1002 },
  ]);
  expect(takeFridgeRequests(dir, 1500)).toEqual([]);
  expect(readdirSync(dir)).toEqual([]); // ni fichier pris, ni temporaire
});

test('demandes trop vieilles ou trop loin dans le futur ignorées', () => {
  writeFridgeRequest(dir, { root: '/a/old', action: 'freeze', at: 0 });
  writeFridgeRequest(dir, { root: '/a/future', action: 'freeze', at: REQUEST_MAX_AGE_MS + 20_000 });
  writeFridgeRequest(dir, { root: '/a/ok', action: 'freeze', at: REQUEST_MAX_AGE_MS });
  expect(takeFridgeRequests(dir, REQUEST_MAX_AGE_MS + 1).map((r) => r.root)).toEqual(['/a/ok']);
});

test('lien symbolique ou contenu invalide : rien, et le fichier est retiré', () => {
  const target = join(dir, 'cible.json');
  writeFileSync(target, JSON.stringify({ version: 1, requests: [{ root: '/a/b', action: 'freeze', at: 1 }] }));
  symlinkSync(target, fridgeRequestPath(dir));
  expect(takeFridgeRequests(dir, 1)).toEqual([]);
  expect(existsSync(fridgeRequestPath(dir))).toBe(false);
  expect(existsSync(target)).toBe(true); // la cible n'est jamais touchée
  writeFileSync(fridgeRequestPath(dir), '{"version":1,"requests":[{"root":"/","action":"freeze","at":1}]}');
  expect(takeFridgeRequests(dir, 1)).toEqual([]);
  // un fichier de demandes illisible n'empêche pas d'en écrire une nouvelle
  writeFileSync(fridgeRequestPath(dir), 'pas du json');
  writeFridgeRequest(dir, { root: '/a/b', action: 'thaw', at: 5 });
  expect(takeFridgeRequests(dir, 5)).toEqual([{ root: '/a/b', action: 'thaw', at: 5 }]);
});
