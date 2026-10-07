import { describe, expect, test } from 'vitest';
import type { Group, ProcInfo, SystemInfo } from './types';
import { buildSnapshot, findFullGroup, groupMatches, groupProcs, isWatch, summarizeGroup } from './snapshot';

const proc = (pid: number, name: string, extra: Partial<ProcInfo> = {}): ProcInfo => ({
  pid, ppid: 1, name, cmdline: name, uid: 1000, startTicks: pid * 10, ageSec: 10, cpuTicks: 0, cpuPercent: 0,
  rssKB: 0, swapKB: 0, cwd: null, cwdDeleted: false, ...extra,
});

const group = (id: string, procs: ProcInfo[], extra: Partial<Group> = {}): Group => ({
  id, kind: 'command', label: id, tags: [], rootName: procs[0]?.name ?? '',
  roots: procs.length ? [{ proc: procs[0]!, children: procs.slice(1).map((p) => ({ proc: p, children: [] })) }] : [],
  pids: procs.map((p) => p.pid), procCount: procs.length, cpuPercent: 0, rssKB: 0, swapKB: 0, oldestAgeSec: 10,
  protected: false, killable: true, subgroups: [], ...extra,
});

const system: SystemInfo = { memTotalKB: 100, memAvailableKB: 50, swapTotalKB: 0, swapFreeKB: 0, load1: 0, psiSome10: null };

const inner = group('c', [proc(3, 'cron', { cmdline: '/usr/sbin/cron -f' })]);
const groups = [
  group('a', [proc(1, 'vite', { cwd: '/home/u/acme' }), proc(4, 'esbuild', { uid: 0 })], { label: 'acme' }),
  group('b', [proc(2, 'chrome')], { label: 'Chrome' }),
  group('others', [], { kind: 'others', label: 'Autres (1 groupes)', pids: [3], subgroups: [inner] }),
];

describe('summarizeGroup', () => {
  test('retire l\'arbre, garde les totaux et résume les sous-groupes', () => {
    const s = summarizeGroup(groups[2]!);
    expect(s).not.toHaveProperty('roots');
    expect(s.subgroups[0]).not.toHaveProperty('roots');
    expect(s.subgroups[0]).toMatchObject({ id: 'c', pids: [3], procCount: 1 });
    expect(summarizeGroup(groups[0]!)).toMatchObject({ id: 'a', label: 'acme', pids: [1, 4], killable: true });
  });
});

describe('groupMatches', () => {
  test('libellé, commande, dossier (insensible à la casse) et sous-groupes', () => {
    expect(groupMatches(groups[0]!, 'ACME')).toBe(true);
    expect(groupMatches(groups[0]!, '/home/u/acm')).toBe(true);
    expect(groupMatches(groups[0]!, 'esbu')).toBe(true);
    expect(groupMatches(groups[1]!, 'acme')).toBe(false);
    expect(groupMatches(groups[2]!, 'sbin/cron')).toBe(true);
  });
});

describe('buildSnapshot', () => {
  const base = { takenAt: 5, currentUid: 1000, system, groups };

  test('sans suivi : résumés seulement, ni arbre ni recherche', () => {
    const s = buildSnapshot(base, { groupId: null, query: '' });
    expect(s).toMatchObject({ takenAt: 5, currentUid: 1000, system, query: '', matches: null, detail: null });
    expect(s.groups.map((g) => g.id)).toEqual(['a', 'b', 'others']);
    expect(JSON.stringify(s)).not.toContain('"roots"');
  });

  test('sous-groupes de « Autres » envoyés seulement quand « Autres » ou l\'un d\'eux est suivi ; tous les ids toujours', () => {
    const others = (w: string | null) => buildSnapshot(base, { groupId: w, query: '' }).groups.find((g) => g.id === 'others')!;
    expect(others(null)).toMatchObject({ pids: [3], subgroups: [] });
    expect(others('a').subgroups).toEqual([]);
    expect(others('others').subgroups.map((g) => g.id)).toEqual(['c']);
    expect(others('c').subgroups.map((g) => g.id)).toEqual(['c']);
    expect(buildSnapshot(base, { groupId: null, query: '' }).groupIds).toEqual(['a', 'b', 'others', 'c']);
  });

  test('groupe suivi : son arbre seulement, y compris un sous-groupe d\'« Autres »', () => {
    expect(buildSnapshot(base, { groupId: 'a', query: '' }).detail).toEqual({ groupId: 'a', roots: groups[0]!.roots });
    expect(buildSnapshot(base, { groupId: 'c', query: '' }).detail).toEqual({ groupId: 'c', roots: inner.roots });
    expect(buildSnapshot(base, { groupId: 'disparu', query: '' }).detail).toBeNull();
  });

  test('recherche : ids des groupes de premier niveau qui correspondent', () => {
    expect(buildSnapshot(base, { groupId: null, query: ' cron ' })).toMatchObject({ query: 'cron', matches: ['others'] });
    expect(buildSnapshot(base, { groupId: null, query: 'chrome' }).matches).toEqual(['b']);
    expect(buildSnapshot(base, { groupId: null, query: '   ' })).toMatchObject({ query: '', matches: null });
  });
});

test('findFullGroup et groupProcs : tous les processus du groupe, sous-groupes compris', () => {
  expect(findFullGroup(groups, 'c')).toBe(inner);
  expect(findFullGroup(groups, 'x')).toBeUndefined();
  expect(groupProcs(groups, 'a').map((p) => p.pid)).toEqual([1, 4]);
  expect(groupProcs(groups, 'others').map((p) => p.pid)).toEqual([3]);
  expect(groupProcs(groups, 'x')).toEqual([]);
});

test('isWatch valide ce qui vient du renderer', () => {
  expect(isWatch({ groupId: null, query: '' })).toBe(true);
  expect(isWatch({ groupId: 'a', query: 'x' })).toBe(true);
  expect(isWatch({ groupId: 3, query: '' })).toBe(false);
  expect(isWatch({ groupId: null })).toBe(false);
  expect(isWatch({ groupId: null, query: 'x'.repeat(1001) })).toBe(false);
  expect(isWatch(null)).toBe(false);
});
