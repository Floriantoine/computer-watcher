import { describe, expect, test } from 'vitest';
import type { GroupSummary } from '../../core/types';
import { OTHERS_OPEN_KEY, othersPreview, othersPreviewEqual, readOthersOpen, writeOthersOpen } from './othersFold';

const sg = (id: string, memMB: number, extra: Partial<GroupSummary> = {}): GroupSummary => ({
  id, kind: 'command', label: id, tags: [], rootName: id, pids: [1], procCount: 1,
  cpuPercent: 0, rssKB: memMB * 1024, swapKB: 0, oldestAgeSec: 10, protected: false, killable: true, subgroups: [], categories: [], instances: [], ...extra,
});
const others = (subgroups: GroupSummary[]): GroupSummary => ({ ...sg('others', 0, { kind: 'others', label: 'Autres' }), subgroups });

describe('othersPreview', () => {
  test('14 sous-groupes → les 10 plus gros (RAM + swap), 4 cachés', () => {
    const subs = Array.from({ length: 14 }, (_, i) => sg(`c${i}`, i + 1));
    // swap compté : c0 passe devant tout le monde
    subs[0] = sg('c0', 1, { swapKB: 100 * 1024 });
    const { shown, hidden } = othersPreview(others(subs));
    expect(shown.map((g) => g.id)).toEqual(['c0', 'c13', 'c12', 'c11', 'c10', 'c9', 'c8', 'c7', 'c6', 'c5']);
    expect(hidden).toBe(4);
  });
  test('3 sous-groupes → les 3, aucun caché', () => {
    const { shown, hidden } = othersPreview(others([sg('a', 1), sg('b', 3), sg('c', 2)]));
    expect(shown.map((g) => g.id)).toEqual(['b', 'c', 'a']);
    expect(hidden).toBe(0);
  });
});

describe('readOthersOpen / writeOthersOpen', () => {
  test('lecture : « 1 » → déplié ; null → replié ; stockage qui lève → replié', () => {
    expect(readOthersOpen({ getItem: (k) => (k === OTHERS_OPEN_KEY ? '1' : null) })).toBe(true);
    expect(readOthersOpen({ getItem: () => null })).toBe(false);
    expect(readOthersOpen({ getItem: () => '0' })).toBe(false);
    expect(readOthersOpen({ getItem: () => { throw new Error('SecurityError'); } })).toBe(false);
  });
  test('écriture : « 1 » / « 0 » ; stockage qui lève → pas d\'exception', () => {
    const saved: [string, string][] = [];
    writeOthersOpen(true, { setItem: (k, v) => saved.push([k, v]) });
    writeOthersOpen(false, { setItem: (k, v) => saved.push([k, v]) });
    expect(saved).toEqual([[OTHERS_OPEN_KEY, '1'], [OTHERS_OPEN_KEY, '0']]);
    expect(() => writeOthersOpen(true, { setItem: () => { throw new Error('QuotaExceededError'); } })).not.toThrow();
  });
});

describe('othersPreviewEqual', () => {
  const a = others([sg('x', 300), sg('y', 129), sg('z', 50)]);
  test('même ordre, Mo et CPU affichés identiques → égal', () => {
    const b = others([sg('x', 300.2), sg('y', 129.1, { cpuPercent: 0.3 }), sg('z', 50)]);
    expect(othersPreviewEqual(a, b)).toBe(true);
  });
  test('un sous-groupe passe de 129 à 131 Mo → différent', () => {
    expect(othersPreviewEqual(a, others([sg('x', 300), sg('y', 131), sg('z', 50)]))).toBe(false);
  });
  test('ordre inversé → différent', () => {
    expect(othersPreviewEqual(a, others([sg('x', 300), sg('z', 129), sg('y', 50)]))).toBe(false);
  });
  test('CPU affiché différent ou nombre de cachés différent → différent', () => {
    expect(othersPreviewEqual(a, others([sg('x', 300, { cpuPercent: 2 }), sg('y', 129), sg('z', 50)]))).toBe(false);
    const many = (n: number) => others(Array.from({ length: n }, (_, i) => sg(`c${i}`, 100 - i)));
    expect(othersPreviewEqual(many(12), many(13))).toBe(false);
  });
});
