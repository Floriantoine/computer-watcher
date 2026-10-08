import { describe, expect, test } from 'vitest';
import type { GroupSummary, ProcInfo } from '../../core/types';
import { cardDisplayEqual, procRowDisplayEqual, rowDisplayEqual, sameSeries } from './renderEquality';

const g = (extra: Partial<GroupSummary> = {}): GroupSummary => ({
  id: 'app:chrome', kind: 'app', label: 'Chrome', tags: [], rootName: 'chrome', pids: [1, 2], procCount: 2,
  cpuPercent: 3.2, rssKB: 2_000_000, swapKB: 0, oldestAgeSec: 4000, protected: false, killable: true, subgroups: [], categories: [], instances: [], ...extra,
});
const MEM = 32 * 1024 * 1024;

describe('cardDisplayEqual : une carte dont l\'affichage ne change pas ne se re-rend pas', () => {
  test('nouvel objet, mêmes textes affichés (RAM, CPU, âge, jauge) → égal', () => {
    expect(cardDisplayEqual(g(), g({ rssKB: 2_000_300, cpuPercent: 3.4, oldestAgeSec: 4010, pids: [1, 2, 3] }), MEM, MEM)).toBe(true);
  });
  test.each<[string, Partial<GroupSummary>]>([
    ['RAM affichée', { rssKB: 2_300_000 }],
    ['CPU affiché', { cpuPercent: 4.6 }],
    ['âge affiché', { oldestAgeSec: 7300 }],
    ['nombre de processus', { procCount: 3 }],
    ['libellé', { label: 'Chromium' }],
    ['protégé', { protected: true }],
    ['tuable', { killable: false }],
    ['badges', { tags: ['node'] }],
  ])('%s changé → différent', (_, extra) => {
    expect(cardDisplayEqual(g(), g(extra), MEM, MEM)).toBe(false);
  });
  test('RAM totale du système différente (largeur de jauge) → différent', () => {
    expect(cardDisplayEqual(g(), g(), MEM, MEM / 2)).toBe(false);
  });
});

describe('catégories (étiquette, résumé, doublon)', () => {
  const i = (extra: Partial<GroupSummary['instances'][number]> = {}) => ({
    key: 'k', groupId: 'app:chrome', project: null, category: 'front' as const, source: 'command' as const, signature: 'vite', label: 'vite',
    rootPid: 1, rootStartTicks: 1, pids: [1], ports: [5173], ageSec: 10, rssKB: 1, swapKB: 0, cpuPercent: 0, duplicate: false, protected: false, ...extra,
  });
  test('RAM/CPU d\'instance changés → égal ; port, catégorie ou doublon changés → différent (carte et ligne)', () => {
    const a = g({ categories: ['front'], instances: [i()] });
    expect(cardDisplayEqual(a, g({ categories: ['front'], instances: [i({ rssKB: 9, cpuPercent: 4 })] }), MEM, MEM)).toBe(true);
    for (const b of [i({ ports: [5174] }), i({ category: 'back' }), i({ duplicate: true })]) {
      const gb = g({ categories: [b.category], instances: [b] });
      expect(cardDisplayEqual(a, gb, MEM, MEM)).toBe(false);
      expect(rowDisplayEqual(a, gb)).toBe(false);
    }
  });
});

describe('rowDisplayEqual (vue liste)', () => {
  test('même affichage → égal ; swap affiché changé → différent', () => {
    expect(rowDisplayEqual(g(), g({ rssKB: 2_000_300 }))).toBe(true);
    expect(rowDisplayEqual(g({ swapKB: 0 }), g({ swapKB: 50_000 }))).toBe(false);
  });
});

describe('procRowDisplayEqual (arbre du détail)', () => {
  const p = (extra: Partial<ProcInfo> = {}): ProcInfo => ({
    pid: 10, ppid: 1, name: 'node', cmdline: 'node a', uid: 1000, startTicks: 5, ageSec: 100, cpuTicks: 0, cpuPercent: 1,
    rssKB: 50_000, swapKB: 0, cwd: '/p', cwdDeleted: false, ...extra,
  });
  test('ticks CPU ou RSS sous l\'arrondi → égal ; cmdline, CPU affiché, dossier → différent', () => {
    expect(procRowDisplayEqual(p(), p({ cpuTicks: 99, rssKB: 50_100, cpuPercent: 1.2 }))).toBe(true);
    expect(procRowDisplayEqual(p(), p({ cmdline: 'node b' }))).toBe(false);
    expect(procRowDisplayEqual(p(), p({ cpuPercent: 7 }))).toBe(false);
    expect(procRowDisplayEqual(p(), p({ cwd: '/q' }))).toBe(false);
    expect(procRowDisplayEqual(p(), p({ uid: 0 }))).toBe(false);
    expect(procRowDisplayEqual(p(), p({ name: 'zsh' }))).toBe(false); // la protection se décide sur le nom
  });
});

test('sameSeries compare les valeurs', () => {
  const a = [1, null, 3];
  expect(sameSeries(a, a)).toBe(true);
  expect(sameSeries(a, [1, null, 3])).toBe(true);
  expect(sameSeries(a, [1, 2, 3])).toBe(false);
  expect(sameSeries(a, [1, null])).toBe(false);
  expect(sameSeries(undefined, undefined)).toBe(true);
  expect(sameSeries(a, undefined)).toBe(false);
});
