import { describe, expect, test } from 'vitest';
import type { GroupClassification } from './classify/classify';
import type { Group, InstanceSummary, ProcInfo, SystemInfo } from './types';
import { buildSnapshot, findFullGroup, groupMatches, groupProcs, instanceTargets, isWatch, summarizeGroup } from './snapshot';

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

const inst = (groupId: string, rootPid: number, pids: number[], extra: Partial<InstanceSummary> = {}): InstanceSummary => ({
  key: `${groupId}#${rootPid}:${rootPid * 10}`, groupId, project: null, category: 'front', source: 'command', signature: 'vite', label: 'vite',
  rootPid, rootStartTicks: rootPid * 10, pids, ports: [], ageSec: 10, rssKB: 0, swapKB: 0, cpuPercent: 0, duplicate: false, protected: false, ...extra,
});
const classification = new Map<string, GroupClassification>([
  ['a', { categories: ['front'], instances: [inst('a', 1, [1, 4])], launcherPids: [] }],
  ['b', { categories: ['browser'], instances: [inst('b', 2, [2], { category: 'browser', source: 'name' })], launcherPids: [] }],
  ['others', { categories: [], instances: [], launcherPids: [] }],
  ['c', { categories: ['system'], instances: [inst('c', 3, [3], { category: 'system', source: 'name' })], launcherPids: [] }],
]);

describe('buildSnapshot', () => {
  const base = { takenAt: 5, currentUid: 1000, system, groups, classification };

  test('résumés : catégories et instances du classement, sous-groupes détaillés d\'« Autres » compris', () => {
    const s = buildSnapshot(base, { groupId: 'others', query: '' });
    expect(s.groups[0]).toMatchObject({ id: 'a', categories: ['front'] });
    expect(s.groups[0]!.instances.map((i) => i.key)).toEqual(['a#1:10']);
    expect(s.groups[1]!.categories).toEqual(['browser']);
    expect(s.groups[2]).toMatchObject({ categories: [], instances: [] });
    expect(s.groups[2]!.subgroups[0]).toMatchObject({ id: 'c', categories: ['system'] });
    expect(s.groups[2]!.subgroups[0]!.instances[0]!.key).toBe('c#3:30');
    // groupe absent du classement : vide
    const none = buildSnapshot({ ...base, classification: new Map() }, { groupId: null, query: '' });
    expect(none.groups[0]).toMatchObject({ categories: [], instances: [] });
  });

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
    expect(buildSnapshot(base, { groupId: 'disparu', query: '' })).toMatchObject({ detail: null, watched: 'disparu' });
    expect(buildSnapshot(base, { groupId: null, query: '' }).watched).toBeNull();
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

test('instanceTargets : cibles {pid, startTicks} des instances (disparues absentes), lanceurs pour une clé de groupe', () => {
  const cls = new Map(classification);
  cls.set('a', { categories: ['front'], instances: [inst('a', 1, [1, 4])], launcherPids: [4] });
  const full = { takenAt: 5, currentUid: 1000, system, groups, classification: cls };
  expect(instanceTargets(full, ['a#1:10', 'c#3:30', 'a#9:90', 'zz'])).toEqual([
    { key: 'a#1:10', targets: [{ pid: 1, startTicks: 10 }, { pid: 4, startTicks: 40 }] },
    { key: 'c#3:30', targets: [{ pid: 3, startTicks: 30 }] },
  ]);
  expect(instanceTargets(full, ['a'])).toEqual([{ key: 'a', targets: [{ pid: 4, startTicks: 40 }] }]);
  expect(instanceTargets(full, ['b'])).toEqual([{ key: 'b', targets: [] }]);
});

test('isWatch valide ce qui vient du renderer', () => {
  expect(isWatch({ groupId: null, query: '' })).toBe(true);
  expect(isWatch({ groupId: 'a', query: 'x' })).toBe(true);
  expect(isWatch({ groupId: 3, query: '' })).toBe(false);
  expect(isWatch({ groupId: null })).toBe(false);
  expect(isWatch({ groupId: null, query: 'x'.repeat(1001) })).toBe(false);
  expect(isWatch(null)).toBe(false);
});
