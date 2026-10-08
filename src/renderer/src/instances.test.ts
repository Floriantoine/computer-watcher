import { describe, expect, test } from 'vitest';
import type { Category, GroupSummary, InstanceSummary } from '../../core/types';
import type { ProcInfo, ProcNode } from '../../core/types';
import { headerKillActions, instanceKillPlan, instanceRowEqual, instanceSpark, menuIndex, projectName, reclassifyMessage, reclassifyScope, showRevertToAuto, skipInstanceKill, sortInstances, ticksIndex } from './instances';

let n = 0;
const inst = (category: Category, extra: Partial<InstanceSummary> = {}): InstanceSummary => {
  n++;
  return {
    key: `k${n}`, groupId: 'g', project: '/home/u/acme', category, source: 'command', signature: 'x', label: 'x', rootPid: 100 + n, rootStartTicks: n,
    pids: [100 + n], ports: [], ageSec: 100, rssKB: 1000, swapKB: 0, cpuPercent: 0, duplicate: false, protected: false, ...extra,
  };
};
const grp = (instances: InstanceSummary[], extra: Partial<GroupSummary> = {}): GroupSummary => ({
  id: 'g', kind: 'project', label: 'acme', tags: [], rootName: 'node', pids: instances.flatMap((i) => i.pids), procCount: instances.length,
  cpuPercent: 0, rssKB: 0, swapKB: 0, oldestAgeSec: 0, protected: false, killable: true, subgroups: [],
  categories: [...new Set(instances.map((i) => i.category))], instances, ...extra,
});

describe('sortInstances', () => {
  test('ordre des catégories, puis la plus ancienne d\'abord ; ne modifie pas l\'entrée', () => {
    const a = inst('back', { ageSec: 10 });
    const b = inst('front', { ageSec: 5 });
    const c = inst('back', { ageSec: 50 });
    const input = [a, b, c];
    expect(sortInstances(input)).toEqual([b, c, a]);
    expect(input).toEqual([a, b, c]);
  });
});

describe('instanceSpark', () => {
  const sparks = new Map<string, (number | null)[]>([
    ['10:1', [100, 200, null]],
    ['11:7', [null, 50, 60]],
    ['12:9', [1, 1, 1]],
  ]);
  const ticks = new Map([[10, 1], [11, 7], [12, 99]]);
  test('somme point à point des séries de ses processus (pid + startTicks)', () => {
    expect(instanceSpark(inst('back', { pids: [10, 11, 12] }), sparks, ticks)).toEqual([100, 250, 60]);
  });
  test('aucune série connue → undefined', () => {
    expect(instanceSpark(inst('back', { pids: [12, 13] }), sparks, ticks)).toBeUndefined();
  });
  test('racine retrouvée sans l\'arbre grâce à rootStartTicks', () => {
    expect(instanceSpark(inst('back', { pids: [10], rootPid: 10, rootStartTicks: 1 }), sparks, new Map())).toEqual([100, 200, null]);
  });
});

describe('headerKillActions', () => {
  test('front, back et « Tout arrêter » selon les catégories présentes, protégées comprises', () => {
    const f = inst('front');
    const b1 = inst('back', { protected: true });
    const b2 = inst('back');
    const w = inst('worker');
    const acts = headerKillActions(grp([f, b1, b2, w]));
    expect(acts.map((a) => [a.id, a.label, a.instances.length, a.launchersOf])).toEqual([
      ['front', 'Tuer le front', 1, undefined],
      ['back', 'Tuer le back', 2, undefined],
      ['all', 'Tout arrêter', 4, 'g'],
    ]);
  });
  test('sans front ni back : seulement « Tout arrêter »', () => {
    expect(headerKillActions(grp([inst('worker')])).map((a) => a.id)).toEqual(['all']);
  });
  test('rien pour un groupe sans instance, non tuable, ou qui n\'est pas un projet', () => {
    expect(headerKillActions(grp([]))).toEqual([]);
    expect(headerKillActions(grp([inst('front')], { killable: false }))).toEqual([]);
    expect(headerKillActions(grp([inst('browser')], { kind: 'app' }))).toEqual([]);
  });
  test('dossier supprimé : comme un projet', () => {
    expect(headerKillActions(grp([inst('back')], { kind: 'deleted' })).map((a) => a.id)).toEqual(['back', 'all']);
  });
});

describe('Reclasser', () => {
  test('portée de la correction : racine du projet, sinon id du groupe', () => {
    expect(reclassifyScope(inst('back'))).toBe('/home/u/acme');
    expect(reclassifyScope(inst('back', { project: null, groupId: 'app:chrome' }))).toBe('app:chrome');
  });
  test('nom affiché : dernier segment du projet, sinon libellé du groupe', () => {
    expect(projectName(inst('back'), 'x / acme')).toBe('acme');
    expect(projectName(inst('back', { project: '/home/u/acme/' }), 'x')).toBe('acme');
    expect(projectName(inst('back', { project: null }), 'Chrome')).toBe('Chrome');
  });
  test('message du toast', () => {
    expect(reclassifyMessage('back', 'acme')).toBe('Classée comme Back pour acme');
    expect(reclassifyMessage('db', 'acme')).toBe('Classée comme BDD pour acme');
    expect(reclassifyMessage(null, 'acme')).toBe('Classement automatique rétabli pour acme');
  });
});

describe('menu « Reclasser »', () => {
  test('« Revenir à l\'automatique » seulement pour une correction manuelle', () => {
    expect(showRevertToAuto(inst('back', { source: 'manual' }))).toBe(true);
    for (const source of ['command', 'port', 'package', 'name', 'unknown'] as const) expect(showRevertToAuto(inst('back', { source }))).toBe(false);
  });
  test('flèches, Début et Fin : navigation circulaire', () => {
    expect(menuIndex(0, 'ArrowDown', 12)).toBe(1);
    expect(menuIndex(11, 'ArrowDown', 12)).toBe(0);
    expect(menuIndex(0, 'ArrowUp', 12)).toBe(11);
    expect(menuIndex(-1, 'ArrowDown', 12)).toBe(0);
    expect(menuIndex(5, 'Home', 12)).toBe(0);
    expect(menuIndex(5, 'End', 12)).toBe(11);
    expect(menuIndex(5, 'Enter', 12)).toBeNull();
  });
});

const proc = (pid: number, extra: Partial<ProcInfo> = {}): ProcInfo => ({
  pid, ppid: 1, name: 'node', cmdline: 'node', uid: 1000, startTicks: pid, ageSec: 10, cpuTicks: 0, cpuPercent: 0,
  rssKB: 0, swapKB: 0, cwd: null, cwdDeleted: false, ...extra,
});

describe('instanceKillPlan', () => {
  const isProtected = (n: string) => n === 'zsh';
  const i = inst('back', { key: 'g#1:1', pids: [1, 2], label: 'nest start' });
  test('instance absente du dernier snapshot → n\'existe plus', () => {
    expect(instanceKillPlan(i, [], [proc(1)], isProtected, 1000)).toEqual({ error: "Cette instance n'existe plus" });
  });
  test('processus tous à un autre utilisateur → message dédié', () => {
    const r = instanceKillPlan(i, [{ key: 'g#1:1', targets: [{ pid: 1, startTicks: 1 }] }], [proc(1, { uid: 33 })], isProtected, 1000);
    expect(r).toEqual({ error: 'Les processus de cette instance appartiennent à un autre utilisateur' });
  });
  test('processus remplacés (startTicks) → n\'existe plus', () => {
    const r = instanceKillPlan(i, [{ key: 'g#1:1', targets: [{ pid: 1, startTicks: 1 }] }], [proc(1, { startTicks: 9 })], isProtected, 1000);
    expect(r).toEqual({ error: "Cette instance n'existe plus" });
  });
  test('instance protégée → requête avec confirmation', () => {
    const r = instanceKillPlan({ ...i, protected: true }, [{ key: 'g#1:1', targets: [{ pid: 1, startTicks: 1 }] }], [proc(1)], isProtected, 1000);
    expect('request' in r && r.request.needsConfirm).toBe(true);
  });
  test('processus protégé par son nom → confirmation même si l\'instance ne l\'est pas', () => {
    const r = instanceKillPlan(i, [{ key: 'g#1:1', targets: [{ pid: 1, startTicks: 1 }] }], [proc(1, { name: 'zsh' })], isProtected, 1000);
    expect('request' in r && r.request.needsConfirm).toBe(true);
  });
  test('ni l\'un ni l\'autre → pas de confirmation', () => {
    const r = instanceKillPlan(i, [{ key: 'g#1:1', targets: [{ pid: 1, startTicks: 1 }] }], [proc(1)], isProtected, 1000);
    expect('request' in r && r.request.needsConfirm).toBe(false);
  });
});

describe('skipInstanceKill (double clic)', () => {
  const i = inst('back', { key: 'k', pids: [1, 2] });
  test('demande déjà en cours pour cette instance', () => {
    expect(skipInstanceKill(i, new Set(['k']), new Set())).toBe(true);
  });
  test('SIGTERM déjà envoyé à tous ses processus', () => {
    expect(skipInstanceKill(i, new Set(), new Set([1, 2]))).toBe(true);
    expect(skipInstanceKill(i, new Set(), new Set([1]))).toBe(false);
    expect(skipInstanceKill(i, new Set(), new Set())).toBe(false);
  });
});

describe('ticksIndex', () => {
  const node = (pid: number, startTicks: number, children: ProcNode[] = []): ProcNode => ({ proc: proc(pid, { startTicks }), children }) as ProcNode;
  test('pid → startTicks de tout l\'arbre', () => {
    expect([...ticksIndex([node(1, 10, [node(2, 20, [node(3, 30)])])], undefined)]).toEqual([[1, 10], [2, 20], [3, 30]]);
  });
  test('même contenu → même objet (pas de re-rendu)', () => {
    const prev = ticksIndex([node(1, 10, [node(2, 20)])], undefined);
    expect(ticksIndex([node(1, 10, [node(2, 20)])], prev)).toBe(prev);
    expect(ticksIndex([node(1, 10, [node(2, 21)])], prev)).not.toBe(prev);
    expect(ticksIndex(null, prev).size).toBe(0);
  });
});

describe('instanceRowEqual', () => {
  const base = { inst: inst('back', { ports: [3000] }), spark: [1, 2] as (number | null)[], stuck: [] as number[], pending: false, canKill: true, menuOpen: false };
  test('nouvel objet, même affichage → égal', () => {
    expect(instanceRowEqual(base, { ...base, inst: { ...base.inst, pids: [...base.inst.pids] }, spark: [1, 2], stuck: [] })).toBe(true);
  });
  test('un champ affiché change → différent', () => {
    expect(instanceRowEqual(base, { ...base, inst: { ...base.inst, rssKB: 5 } })).toBe(false);
    expect(instanceRowEqual(base, { ...base, inst: { ...base.inst, source: 'manual' } })).toBe(false);
    expect(instanceRowEqual(base, { ...base, inst: { ...base.inst, ports: [3001] } })).toBe(false);
    expect(instanceRowEqual(base, { ...base, spark: [1, 3] })).toBe(false);
    expect(instanceRowEqual(base, { ...base, stuck: [4] })).toBe(false);
    expect(instanceRowEqual(base, { ...base, menuOpen: true })).toBe(false);
    expect(instanceRowEqual(base, { ...base, pending: true })).toBe(false);
    expect(instanceRowEqual(base, { ...base, inst: { ...base.inst, protected: true } })).toBe(false);
  });
});
