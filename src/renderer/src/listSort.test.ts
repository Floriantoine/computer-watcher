import { expect, test } from 'vitest';
import type { GroupSummary } from '../../core/types';
import { sortForList } from './listSort';

const g = (id: string, extra: Partial<GroupSummary>): GroupSummary => ({
  id, kind: 'command', label: id, tags: [], rootName: id, pids: [], procCount: 1, cpuPercent: 0, rssKB: 0, swapKB: 0,
  oldestAgeSec: 0, protected: false, killable: true, subgroups: [], categories: [], instances: [], ...extra,
});

test('tri par colonne, Autres en dernier quel que soit le sens', () => {
  const list = [g('b', { rssKB: 5, cpuPercent: 9 }), g('others', { kind: 'others', rssKB: 999 }), g('a', { rssKB: 10, cpuPercent: 1 })];
  expect(sortForList(list, 'mem', 'desc').map((x) => x.id)).toEqual(['a', 'b', 'others']);
  expect(sortForList(list, 'mem', 'asc').map((x) => x.id)).toEqual(['b', 'a', 'others']);
  expect(sortForList(list, 'cpu', 'desc').map((x) => x.id)).toEqual(['b', 'a', 'others']);
  expect(sortForList(list, 'name', 'asc').map((x) => x.id)).toEqual(['a', 'b', 'others']);
});

test('RAM : ordre précédent gardé sous la tolérance, dans les deux sens', () => {
  const list = [g('a', { rssKB: 100_000 }), g('b', { rssKB: 103_000 })];
  expect(sortForList(list, 'mem', 'desc', ['a', 'b']).map((x) => x.id)).toEqual(['a', 'b']);
  expect(sortForList(list, 'mem', 'asc', ['b', 'a']).map((x) => x.id)).toEqual(['b', 'a']);
  expect(sortForList(list, 'mem', 'asc').map((x) => x.id)).toEqual(['a', 'b']);
});
