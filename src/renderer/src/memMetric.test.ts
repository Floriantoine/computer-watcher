import { expect, test } from 'vitest';
import { leakMemOf, memLabel, procMemTitle } from './memMetric';

test('memLabel : RAM en RSS, PSS en PSS', () => {
  expect(memLabel('rss')).toBe('RAM');
  expect(memLabel('pss')).toBe('PSS');
});

test('procMemTitle : infobulle de repli seulement en PSS pour un processus illisible', () => {
  expect(procMemTitle({ pssDenied: true }, 'rss')).toBeUndefined();
  expect(procMemTitle({ pssDenied: true }, 'pss')).toBe('RSS (PSS illisible)');
  expect(procMemTitle({ pssDenied: false }, 'pss')).toBeUndefined();
  expect(procMemTitle({}, 'pss')).toBeUndefined();
});

test('leakMemOf : pas de comparaison avec la mémoire enregistrée (RSS) en PSS', () => {
  const mem = new Map([['a', 10]]);
  expect(leakMemOf('pss', mem)).toBeUndefined();
  const f = leakMemOf('rss', mem);
  expect(typeof f).toBe('function');
  expect(f!('a')).toBe(10);
  expect(f!('b')).toBeUndefined();
});
