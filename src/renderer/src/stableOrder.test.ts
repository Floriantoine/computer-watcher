import { describe, expect, test } from 'vitest';
import { memOutOfOrder, cpuOutOfOrder, stableOrder } from './stableOrder';

type G = { id: string; v: number };
const g = (id: string, v: number): G => ({ id, v });
const byV = (a: G, b: G) => b.v - a.v > 10; // a doit passer après b si b dépasse a de plus de 10
const ids = (xs: G[]) => xs.map((x) => x.id);

describe('stableOrder', () => {
  test('sans ordre précédent : ordre donné, corrigé seulement au-delà de la tolérance', () => {
    expect(ids(stableOrder([g('a', 100), g('b', 50)], [], (x) => x.id, byV))).toEqual(['a', 'b']);
  });
  test('deux voisins proches gardent leur ordre précédent', () => {
    expect(ids(stableOrder([g('b', 105), g('a', 100)], ['a', 'b'], (x) => x.id, byV))).toEqual(['a', 'b']);
  });
  test('un écart au-delà de la tolérance réordonne', () => {
    expect(ids(stableOrder([g('b', 150), g('a', 100)], ['a', 'b'], (x) => x.id, byV))).toEqual(['b', 'a']);
  });
  test('un nouveau groupe remonte à sa place, les disparus sont retirés', () => {
    const r = stableOrder([g('n', 500), g('a', 100), g('c', 20)], ['a', 'gone', 'c'], (x) => x.id, byV);
    expect(ids(r)).toEqual(['n', 'a', 'c']);
  });
});

describe('tolérances', () => {
  const m = (id: string, mb: number) => ({ id, rssKB: mb * 1024, swapKB: 0, cpuPercent: 0 });
  test('mémoire : 5 % ou 8 Mo', () => {
    expect(memOutOfOrder(m('a', 1000), m('b', 1040))).toBe(false);
    expect(memOutOfOrder(m('a', 1000), m('b', 1060))).toBe(true);
    expect(memOutOfOrder(m('a', 20), m('b', 27))).toBe(false);
    expect(memOutOfOrder(m('a', 20), m('b', 29))).toBe(true);
  });
  test('CPU : 2 points ou 10 %', () => {
    const c = (id: string, cpuPercent: number) => ({ id, rssKB: 0, swapKB: 0, cpuPercent });
    expect(cpuOutOfOrder(c('a', 3), c('b', 4.5))).toBe(false);
    expect(cpuOutOfOrder(c('a', 3), c('b', 5.5))).toBe(true);
    expect(cpuOutOfOrder(c('a', 100), c('b', 109))).toBe(false);
    expect(cpuOutOfOrder(c('a', 100), c('b', 112))).toBe(true);
  });
});
