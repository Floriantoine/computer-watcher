import { describe, expect, test } from 'vitest';
import type { Category, GroupSummary, InstanceSummary } from '../../core/types';
import { headerKillActions, instanceSpark, projectName, reclassifyMessage, reclassifyScope, sortInstances } from './instances';

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
