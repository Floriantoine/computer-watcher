import { expect, test } from 'vitest';
import { claudeDirs, isUnderAny } from './claudeDirs';

test('claudeDirs : $CLAUDE_CONFIG_DIR absolu, sinon ~/.claude', () => {
  expect(claudeDirs({}, '/home/u')).toEqual(['/home/u/.claude']);
  expect(claudeDirs({ CLAUDE_CONFIG_DIR: '/opt/cc' }, '/home/u')).toEqual(['/opt/cc']);
  expect(claudeDirs({ CLAUDE_CONFIG_DIR: '/opt/cc/' }, '/home/u')).toEqual(['/opt/cc']);
  expect(claudeDirs({ CLAUDE_CONFIG_DIR: 'cc' }, '/home/u')).toEqual(['/home/u/.claude']); // relatif : ignoré
  expect(claudeDirs({ CLAUDE_CONFIG_DIR: '' }, '/home/u')).toEqual(['/home/u/.claude']);
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
