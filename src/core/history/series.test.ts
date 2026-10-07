import { expect, test } from 'vitest';
import { alignSeries, stackSeries, topKeysByMax } from './series';

test('alignSeries : axe commun, trous à null', () => {
  const r = alignSeries([{ t: 0, key: 'a', v: 1 }, { t: 10, key: 'a', v: 2 }, { t: 10, key: 'b', v: 5 }]);
  expect(r.ts).toEqual([0, 10]);
  expect(r.byKey.get('a')).toEqual([1, 2]);
  expect(r.byKey.get('b')).toEqual([null, 5]);
});

test('stackSeries : cumul, null compte pour 0', () => {
  expect(stackSeries([[1, null, 3], [10, 20, null]])).toEqual([[1, 0, 3], [11, 20, 3]]);
});

test('topKeysByMax', () => {
  const m = new Map<string, (number | null)[]>([['a', [1, 9]], ['b', [5, null]], ['c', [7, 2]]]);
  expect(topKeysByMax(m, 2)).toEqual(['a', 'c']);
});
