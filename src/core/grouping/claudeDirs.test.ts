import { expect, test } from 'vitest';
import { claudeDirs, isUnderAny } from './claudeDirs';

const noLinks = (p: string) => p;

test('claudeDirs : ~/.claude, plus $CLAUDE_CONFIG_DIR s\'il est absolu (ajout, pas remplacement)', () => {
  expect(claudeDirs({}, '/home/u', noLinks)).toEqual(['/home/u/.claude']);
  expect(claudeDirs({ CLAUDE_CONFIG_DIR: '/opt/cc' }, '/home/u', noLinks)).toEqual(['/home/u/.claude', '/opt/cc']);
  expect(claudeDirs({ CLAUDE_CONFIG_DIR: '/opt/cc/' }, '/home/u', noLinks)).toEqual(['/home/u/.claude', '/opt/cc']);
  expect(claudeDirs({ CLAUDE_CONFIG_DIR: '/home/u/.claude' }, '/home/u', noLinks)).toEqual(['/home/u/.claude']); // sans doublon
  expect(claudeDirs({ CLAUDE_CONFIG_DIR: 'cc' }, '/home/u', noLinks)).toEqual(['/home/u/.claude']); // relatif : ignoré
  expect(claudeDirs({ CLAUDE_CONFIG_DIR: '' }, '/home/u', noLinks)).toEqual(['/home/u/.claude']);
});

test('claudeDirs : liens symboliques résolus (cwd de /proc déjà résolu) ; dossier absent → chemin tel quel', () => {
  const real = (p: string) => {
    if (p === '/home/u/.claude') return '/home/u/dotfiles/claude';
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  expect(claudeDirs({}, '/home/u', real)).toEqual(['/home/u/.claude', '/home/u/dotfiles/claude']);
  expect(claudeDirs({ CLAUDE_CONFIG_DIR: '/opt/none' }, '/home/u', real)).toEqual(['/home/u/.claude', '/home/u/dotfiles/claude', '/opt/none']);
});

test('claudeDirs : par défaut, realpath du vrai système de fichiers (dossier absent sans exception)', () => {
  expect(claudeDirs({}, '/nonexistent-home-u')).toEqual(['/nonexistent-home-u/.claude']);
});

test('isUnderAny : le dossier lui-même ou un sous-dossier ; pas un voisin au nom proche ; null → faux', () => {
  const d = ['/home/u/.claude'];
  expect(isUnderAny('/home/u/.claude', d)).toBe(true);
  expect(isUnderAny('/home/u/.claude/plugins/x', d)).toBe(true);
  expect(isUnderAny('/home/u/.claude-backup/x', d)).toBe(false);
  expect(isUnderAny('/home/u', d)).toBe(false);
  expect(isUnderAny(null, d)).toBe(false);
  expect(isUnderAny('/home/u/.claude/x', [])).toBe(false);
});
