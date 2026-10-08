import { expect, test } from 'vitest';
import { fallbackTitle, leakMemOf, memLabel, memTileLabel, procMemTitle } from './memMetric';

test('memLabel : RAM en RSS, PSS en PSS', () => {
  expect(memLabel('rss')).toBe('RAM');
  expect(memLabel('pss')).toBe('PSS');
});

test('procMemTitle : infobulle de repli seulement en PSS pour un processus illisible', () => {
  expect(procMemTitle({ pssDenied: true }, 'rss')).toBeUndefined();
  expect(procMemTitle({ pssDenied: true }, 'pss')).toBe('RSS (PSS illisible)');
  expect(procMemTitle({ pssDenied: false }, 'pss')).toBeUndefined();
  expect(procMemTitle({}, 'pss')).toBeUndefined();
  expect(procMemTitle({ pssPending: true }, 'pss')).toBe('PSS pas encore lu');
  expect(procMemTitle({ pssPending: true }, 'rss')).toBeUndefined();
});

test('leakMemOf : pas de comparaison avec la mémoire enregistrée (RSS) en PSS', () => {
  const mem = new Map([['a', 10]]);
  expect(leakMemOf('pss', mem)).toBeUndefined();
  const f = leakMemOf('rss', mem);
  expect(typeof f).toBe('function');
  expect(f!('a')).toBe(10);
  expect(f!('b')).toBeUndefined();
});

test('memTileLabel / fallbackTitle : « PSS* » et infobulle quand des processus du groupe restent en RSS', () => {
  expect(memTileLabel('rss', { pssFallback: 3 })).toBe('RAM');
  expect(memTileLabel('pss', {})).toBe('PSS');
  expect(memTileLabel('pss', { pssFallback: 0 })).toBe('PSS');
  expect(memTileLabel('pss', { pssFallback: 2 })).toBe('PSS*');
  expect(fallbackTitle('pss', { pssFallback: 2 })).toBe('2 processus en RSS (PSS illisible ou pas encore lu)');
  expect(fallbackTitle('pss', { pssFallback: 1 })).toBe('1 processus en RSS (PSS illisible ou pas encore lu)');
  expect(fallbackTitle('pss', {})).toBeUndefined();
  expect(fallbackTitle('rss', { pssFallback: 2 })).toBeUndefined();
});
