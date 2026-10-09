import { expect, test } from 'vitest';
import { cacheLabel, displayName, isTmpDeleteRequest, isValidEntryName, suspectUser, systemEntry, MAX_TMP_DELETE } from './tmpClean';

test('noms valides : un seul composant, jamais « . », « .. », « / » ni vide', () => {
  for (const ok of ['jest_rs', '.babel.json', 'a b', 'vite-123', '..x', 'x..']) expect(isValidEntryName(ok)).toBe(true);
  for (const bad of ['', '.', '..', '../etc', 'a/b', '/etc', 'a/..', 'a\0b', 'x'.repeat(256)]) expect(isValidEntryName(bad)).toBe(false);
});

test('liste système', () => {
  for (const s of [
    '.X11-unix', '.ICE-unix', '.XIM-unix', '.font-unix', '.Test-unix', 'systemd-private-abc-def', '.mount_App123', 'ssh-XXXX', 'pulse-abc',
    'tracker-extract-3-files.1000', 'krb5cc_1000', '.X0-lock', '.X1024-lock', 'xauth_abc', 'kde-u', 'plasma-csd-generator.abc', 'tmux-1000',
    'claude-1000', '.proc-watch-trash-abc123', '.proc-watch-test-root', 'runtime-u', '.org.chromium.Chromium.abc', 'snap-private-tmp', 'gpg-abc', 'orbit-u',
  ])
    expect(systemEntry(s), s).toBe(true);
  for (const s of ['jest_rs', 'vite-x', 'ssh', 'Xfile', 'mon-dossier', 'claude', 'gpgx']) expect(systemEntry(s), s).toBe(false);
});

test('caches connus', () => {
  for (const s of ['jest_rs', 'node-compile-cache', 'v8-compile-cache-1000', 'playwright-transform-cache-1000', 'vite-abc', '.babel.7.json', 'ts-node-abc', 'tsx-1000'])
    expect(cacheLabel(s), s).toBe(true);
  for (const s of ['mon-dossier', 'vitex', 'node-compile']) expect(cacheLabel(s), s).toBe(false);
});

test('requête de suppression : 1 à 50 {name, ino, dev}, ino/dev en chaînes décimales (bigint)', () => {
  const item = { name: 'a', ino: '18446744073709551615', dev: '2' };
  expect(isTmpDeleteRequest([item])).toBe(true);
  expect(isTmpDeleteRequest(Array.from({ length: MAX_TMP_DELETE }, (_, i) => ({ ...item, name: `a${i}` })))).toBe(true);
  expect(MAX_TMP_DELETE).toBe(50);
  expect(isTmpDeleteRequest(Array.from({ length: 51 }, (_, i) => ({ ...item, name: `a${i}` })))).toBe(false);
  expect(isTmpDeleteRequest([])).toBe(false);
  expect(isTmpDeleteRequest('a')).toBe(false);
  expect(isTmpDeleteRequest([{ name: 'a', ino: 1, dev: '2' }])).toBe(false);
  expect(isTmpDeleteRequest([{ name: 'a', ino: '1x', dev: '2' }])).toBe(false);
  expect(isTmpDeleteRequest([{ name: 'a', ino: '-1', dev: '2' }])).toBe(false);
  expect(isTmpDeleteRequest([{ name: 1, ino: '1', dev: '2' }])).toBe(false);
  expect(isTmpDeleteRequest([null])).toBe(false);
});

test('affichage : caractères de contrôle, bidi et invisibles échappés et signalés', () => {
  expect(displayName('jest_rs')).toEqual({ text: 'jest_rs', escaped: false });
  expect(displayName('a\u202etxt.exe')).toEqual({ text: 'a\\u{202e}txt.exe', escaped: true });
  expect(displayName('a\nb\tc\u0007')).toEqual({ text: 'a\\u{a}b\\u{9}c\\u{7}', escaped: true });
  expect(displayName('x\u200by\u2066\ufeff\u0085').escaped).toBe(true);
});

test('processus non vérifiables : nom qui contient leur comm ou un préfixe connu → « peut-être utilisé »', () => {
  const u = [{ pid: 1, name: 'warp' }, { pid: 2, name: '(sd-pam)' }, { pid: 3, name: 'ps' }, { pid: 4, name: 'kwin_wayland' }];
  expect(suspectUser('warp-terminal-abc', u)).toBe('warp');
  expect(suspectUser('KWin_Wayland.sock.d', u)).toBe('kwin_wayland');
  expect(suspectUser('sd-pam-x', u)).toBe('sd-pam');
  expect(suspectUser('xwayland-abc', [])).toBe('xwayland');
  expect(suspectUser('polkit-agent', [])).toBe('polkit');
  expect(suspectUser('kwallet5', [])).toBe('kwallet');
  expect(suspectUser('caps-test', u)).toBeNull(); // comm « ps » trop court pour une recherche par contenu
  expect(suspectUser('ps-abc', u)).toBe('ps'); // …mais compte en préfixe
  expect(suspectUser('jest_rs', u)).toBeNull();
});
