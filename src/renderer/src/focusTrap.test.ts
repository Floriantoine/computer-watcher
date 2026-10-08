import { expect, test } from 'vitest';
import { trapFocusIndex } from './focusTrap';

test('Tab reste dans le dialogue : du dernier au premier, Maj+Tab du premier au dernier', () => {
  expect(trapFocusIndex(2, 3, false)).toBe(0);
  expect(trapFocusIndex(0, 3, true)).toBe(2);
  expect(trapFocusIndex(1, 3, false)).toBeNull();
  expect(trapFocusIndex(1, 3, true)).toBeNull();
});

test('focus hors du dialogue : ramené au premier (ou au dernier avec Maj)', () => {
  expect(trapFocusIndex(-1, 3, false)).toBe(0);
  expect(trapFocusIndex(-1, 3, true)).toBe(2);
  expect(trapFocusIndex(-1, 0, false)).toBeNull();
});
