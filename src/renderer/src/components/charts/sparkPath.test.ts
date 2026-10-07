import { expect, test } from 'vitest';
import { sparkPath } from './sparkPath';

test('ligne normalisée dans la boîte, y inversé', () => {
  expect(sparkPath([0, 10], 100, 20).line).toBe('M0,20L100,0');
});
test('valeurs constantes : ligne au milieu', () => {
  expect(sparkPath([5, 5, 5], 100, 20).line).toBe('M0,10L50,10L100,10');
});
test('null : coupe la ligne', () => {
  expect(sparkPath([0, null, 10], 100, 20).line).toBe('M0,20M100,0');
});
test('aire fermée sur la base', () => {
  expect(sparkPath([0, 10], 100, 20).area).toBe('M0,20L100,0L100,20L0,20Z');
});
test('vide → chaînes vides', () => {
  expect(sparkPath([], 100, 20)).toEqual({ line: '', area: '' });
});
