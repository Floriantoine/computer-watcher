import { expect, test } from 'vitest';
import { cacheLabel, isTmpDeleteRequest, isValidEntryName, systemEntry, MAX_TMP_DELETE } from './tmpClean';

test('noms valides : un seul composant, jamais « . », « .. », « / » ni vide', () => {
  for (const ok of ['jest_rs', '.babel.json', 'a b', 'vite-123', '..x', 'x..']) expect(isValidEntryName(ok)).toBe(true);
  for (const bad of ['', '.', '..', '../etc', 'a/b', '/etc', 'a/..', 'a\0b', 'x'.repeat(256)]) expect(isValidEntryName(bad)).toBe(false);
});

test('liste système', () => {
  for (const s of ['.X11-unix', '.ICE-unix', '.XIM-unix', '.font-unix', '.Test-unix', 'systemd-private-abc-def', '.mount_App123', 'ssh-XXXX', 'pulse-abc', 'tracker-extract-3-files.1000', 'krb5cc_1000', '.X0-lock', '.X1024-lock', 'xauth_abc', 'kde-u', 'plasma-csd-generator.abc', 'tmux-1000'])
    expect(systemEntry(s), s).toBe(true);
  for (const s of ['jest_rs', 'vite-x', 'ssh', 'Xfile', 'mon-dossier']) expect(systemEntry(s), s).toBe(false);
});

test('caches connus', () => {
  for (const s of ['jest_rs', 'node-compile-cache', 'v8-compile-cache-1000', 'playwright-transform-cache-1000', 'vite-abc', '.babel.7.json', 'ts-node-abc', 'tsx-1000'])
    expect(cacheLabel(s), s).toBe(true);
  for (const s of ['mon-dossier', 'vitex', 'node-compile']) expect(cacheLabel(s), s).toBe(false);
});

test('requête de suppression : tableau de {name, ino, dev}, au plus 50', () => {
  const item = { name: 'a', ino: 1, dev: 2 };
  expect(isTmpDeleteRequest([item])).toBe(true);
  expect(isTmpDeleteRequest(Array.from({ length: MAX_TMP_DELETE }, (_, i) => ({ ...item, name: `a${i}` })))).toBe(true);
  expect(MAX_TMP_DELETE).toBe(50);
  expect(isTmpDeleteRequest(Array.from({ length: 51 }, (_, i) => ({ ...item, name: `a${i}` })))).toBe(false);
  expect(isTmpDeleteRequest([])).toBe(false);
  expect(isTmpDeleteRequest('a')).toBe(false);
  expect(isTmpDeleteRequest([{ name: 'a', ino: '1', dev: 2 }])).toBe(false);
  expect(isTmpDeleteRequest([{ name: 1, ino: 1, dev: 2 }])).toBe(false);
  expect(isTmpDeleteRequest([{ name: 'a', ino: 1.5, dev: 2 }])).toBe(false);
  expect(isTmpDeleteRequest([null])).toBe(false);
});
