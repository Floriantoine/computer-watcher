import { describe, expect, test } from 'vitest';
import type { ProcInfo, ProcNode } from '../../core/types';
import { allExpandableKeys, branchTotals } from './tree';

const node = (pid: number, rssKB: number, swapKB: number, children: ProcNode[] = []): ProcNode => ({
  proc: { pid, ppid: 1, name: 'p', cmdline: 'p', uid: 1000, startTicks: 7, ageSec: 1, cpuTicks: 0, cpuPercent: 0, rssKB, swapKB, cwd: null, cwdDeleted: false } as ProcInfo,
  children,
});

describe('branchTotals', () => {
  test('arbre à 3 niveaux', () => {
    const tree = node(1, 100, 10, [node(2, 50, 0, [node(3, 20, 5), node(4, 1, 1)]), node(5, 30, 0)]);
    const t = branchTotals([tree]);
    expect(t.get('1:7')).toEqual({ memKB: 217, count: 5 });
    expect(t.get('2:7')).toEqual({ memKB: 77, count: 3 });
    expect(t.get('3:7')).toEqual({ memKB: 25, count: 1 });
  });
  test('feuille seule', () => {
    expect(branchTotals([node(9, 5, 2)]).get('9:7')).toEqual({ memKB: 7, count: 1 });
    expect(allExpandableKeys([node(9, 5, 2)])).toEqual([]);
  });
  test('données arbitraires mais finies : plusieurs racines, profondeur', () => {
    let chain = node(100, 1, 0);
    for (let i = 99; i > 0; i--) chain = node(i, 1, 0, [chain]);
    const t = branchTotals([chain, node(200, 3, 0)]);
    expect(t.get('1:7')).toEqual({ memKB: 100, count: 100 });
    expect(t.size).toBe(101);
    expect(allExpandableKeys([chain, node(200, 3, 0)])).toHaveLength(99);
  });
});

describe('allExpandableKeys', () => {
  test('ne liste que les nœuds avec enfants', () => {
    const tree = node(1, 0, 0, [node(2, 0, 0, [node(3, 0, 0)]), node(4, 0, 0)]);
    expect(allExpandableKeys([tree])).toEqual(['1:7', '2:7']);
  });
});
