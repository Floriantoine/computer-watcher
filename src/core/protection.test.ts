import { expect, test } from 'vitest';
import { compileProtection } from './protection';

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
