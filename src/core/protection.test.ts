import { expect, test } from 'vitest';
import { compileProtection, normalizeProjectDirs } from './protection';

test('nom exact', () => {
  const p = compileProtection(['zsh', 'tmux: server']);
  expect(p.isProtected('zsh')).toBe(true);
  expect(p.isProtected('tmux: server')).toBe(true);
  expect(p.isProtected('zsh2')).toBe(false);
});

test('regex entre slashs', () => {
  const p = compileProtection(['/^systemd/']);
  expect(p.isProtected('systemd-journal')).toBe(true);
  expect(p.isProtected('mysystemd')).toBe(false);
});

test('regex invalide → ignorée et signalée, les autres entrées marchent', () => {
  const p = compileProtection(['/([/', 'bash']);
  expect(p.invalid).toEqual(['/([/']);
  expect(p.isProtected('bash')).toBe(true);
  expect(p.isProtected('([')).toBe(false);
});

test('dossier de projet protégé : le dossier et ses sous-dossiers, jamais un voisin', () => {
  const p = compileProtection([], ['/p/LaCrypte']);
  expect(p.isProtected('MainThread', '/p/LaCrypte')).toBe(true);
  expect(p.isProtected('next-server (v1', '/p/LaCrypte/apps/web')).toBe(true);
  expect(p.isProtected('MainThread', '/p/LaCrypte2')).toBe(false);
  expect(p.isProtected('MainThread', '/p')).toBe(false);
  expect(p.isProtected('MainThread', null)).toBe(false);
  expect(p.isProtected('MainThread')).toBe(false);
});

test('noms et dossiers se cumulent', () => {
  const p = compileProtection(['zsh'], ['/p/L']);
  expect(p.isProtected('zsh', '/ailleurs')).toBe(true);
  expect(p.isProtected('node', '/p/L')).toBe(true);
  expect(p.isProtected('node', '/ailleurs')).toBe(false);
});

test('normalizeProjectDirs : absolus, sans / final, sans / seul ni doublon ; autre chose → []', () => {
  expect(normalizeProjectDirs(['/a/b/', '/a/b', 'rel', '/', 3, '', '//'])).toEqual(['/a/b']);
  expect(normalizeProjectDirs('x')).toEqual([]);
  expect(normalizeProjectDirs(undefined)).toEqual([]);
});
