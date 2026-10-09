import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { openInFileManager } from './diskOpen';

mkdirSync(join(homedir(), '.cache'), { recursive: true });
const base = realpathSync(mkdtempSync(join(homedir(), '.cache', 'pw-disk-open-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const home = join(base, 'home');
mkdirSync(join(home, 'Documents/a'), { recursive: true });
mkdirSync(join(base, 'dehors'));
symlinkSync(join(base, 'dehors'), join(home, 'lien'));

test('dossier sous HOME : xdg-open par chemin absolu, environnement nettoyé, chemin réel', () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const r = openInFileManager(join(home, 'Documents/a'), { home, spawn: (cmd, args) => calls.push({ cmd, args }), exists: () => true });
  expect(r).toEqual({ ok: true });
  expect(calls).toEqual([{ cmd: '/usr/bin/xdg-open', args: [join(home, 'Documents/a')] }]);
});

test('refusé : hors HOME, lien qui sort de HOME, relatif, « .. », caractère nul, absent', () => {
  const calls: unknown[] = [];
  const o = { home, spawn: (...a: unknown[]) => calls.push(a), exists: () => true };
  for (const p of ['/etc', join(home, 'lien'), 'Documents', `${home}/Documents/../../dehors`, `${home}/a\u0000b`, join(home, 'absent')]) {
    expect(openInFileManager(p, o).ok, p).toBe(false);
  }
  expect(calls).toEqual([]);
});

test('xdg-open absent : message clair', () => {
  expect(openInFileManager(join(home, 'Documents'), { home, spawn: () => {}, exists: () => false })).toEqual({ ok: false, error: 'xdg-open introuvable' });
});
