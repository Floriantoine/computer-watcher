import { expect, test } from 'vitest';
import { CATEGORIES, DUPLICATE_CATEGORIES, isCategory } from './categories';

test('isCategory accepte les 11 catégories', () => {
  expect(CATEGORIES).toHaveLength(11);
  for (const c of CATEGORIES) expect(isCategory(c)).toBe(true);
});

test.each(['Front', '', 3, null, undefined, {}])('isCategory refuse %j', (v) => {
  expect(isCategory(v)).toBe(false);
});

test('catégories sujettes aux doublons', () => {
  expect([...DUPLICATE_CATEGORIES].sort()).toEqual(['back', 'db', 'front', 'worker']);
});
