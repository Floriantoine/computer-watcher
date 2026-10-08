import { describe, expect, it } from 'vitest';
import type { GroupClassification } from './classify/classify';
import { group, node, proc } from './classify/testFixtures';
import type { ListenSocket } from './collector/ports';
import { openPorts, portMatches } from './openPorts';
import type { FullSnapshot } from './snapshot';
import type { Group, InstanceSummary, SystemInfo } from './types';

const system: SystemInfo = { memTotalKB: 100, memAvailableKB: 50, swapTotalKB: 0, swapFreeKB: 0, load1: 0, psiSome10: null, shmemKB: 0 };
const inst = (groupId: string, rootPid: number, pids: number[], extra: Partial<InstanceSummary> = {}): InstanceSummary => ({
  key: `${groupId}#${rootPid}:${rootPid * 10}`, groupId, project: 'acme', category: 'back', source: 'command', signature: 'nest start', label: 'nest start',
  rootPid, rootStartTicks: rootPid * 10, pids, ports: [3000], ageSec: 600, rssKB: 0, swapKB: 0, cpuPercent: 0, duplicate: false, protected: false, ...extra,
});

const nest = proc('node', 'node nest start', { pid: 20, ageSec: 600 });
const npm = proc('npm', 'npm run start', { pid: 19 });
const code = proc('code', '/usr/bin/code', { pid: 30, ageSec: 7200 });
const forkA = proc('node', 'node server.js', { pid: 40 });
const forkB = proc('node', 'node server.js', { pid: 41 });
const cron = proc('cron', 'cron', { pid: 50 });
const groups: Group[] = [
  group('acme', 'project', [node(npm, node(nest))]),
  { ...group('code', 'app', [node(code)]), label: 'VS Code' },
  group('beta', 'project', [node(forkA), node(forkB)]),
  { ...group('others', 'others', []), subgroups: [group('cron', 'command', [node(cron)])] },
];
const classification = new Map<string, GroupClassification>([
  ['acme', { categories: ['back'], instances: [inst('acme', 20, [20])], launcherPids: [19] }],
  ['code', { categories: [], instances: [], launcherPids: [] }],
  ['beta', { categories: ['back'], instances: [inst('beta', 40, [40], { project: 'beta', label: 'node server.js' }), inst('beta', 41, [41], { project: 'beta', label: 'node server.js' })], launcherPids: [] }],
]);
const full: FullSnapshot = { takenAt: 1, currentUid: 1000, system, groups, classification };

describe('openPorts', () => {
  const byPid = new Map<number, number[]>([[20, [3000]], [30, [41000, 9229]], [40, [8080]], [41, [8080]], [50, [631]]]);
  const sockets: ListenSocket[] = [
    { inode: 1, port: 3000, uid: 1000 }, { inode: 2, port: 9229, uid: 1000 }, { inode: 3, port: 41000, uid: 1000 }, { inode: 4, port: 8080, uid: 1000 },
    { inode: 5, port: 631, uid: 1000 }, { inode: 6, port: 5432, uid: 965 }, { inode: 7, port: 22, uid: 0 }, { inode: 8, port: 5432, uid: 965 },
  ];
  const info = openPorts(full, byPid, sockets, 1000);

  it('instance classée : clé, catégorie, projet, libellé de l\'instance', () => {
    const row = info.ports.find((p) => p.port === 3000)!;
    expect(row).toEqual({
      port: 3000, pid: 20, startTicks: 200, groupId: 'acme', groupLabel: 'acme', instanceKey: 'acme#20:200', category: 'back', project: 'acme',
      label: 'nest start', ageSec: 600, protected: false,
    });
  });

  it('processus d\'un groupe app sans instance : instanceKey null, libellé du processus, groupe à part', () => {
    const row = info.ports.find((p) => p.port === 9229)!;
    expect(row).toMatchObject({ pid: 30, startTicks: 300, groupId: 'code', groupLabel: 'VS Code', instanceKey: null, category: null, project: null, label: 'code', ageSec: 7200 });
  });

  it('hors projet, un descendant qui écoute n\'est pas son instance (serveur lancé depuis une session Claude) : processus seul', () => {
    const claude = proc('claude', 'claude', { pid: 60, ageSec: 86400 });
    const tool = proc('node', 'node server.js', { pid: 61, ageSec: 5 });
    const g = { ...group('claude', 'claude', [node(claude, node(tool))]), label: 'Claude' };
    const cls = new Map<string, GroupClassification>([
      ['claude', { categories: ['ai'], instances: [inst('claude', 60, [60, 61], { category: 'ai', project: null, label: 'claude', ageSec: 86400 })], launcherPids: [] }],
    ]);
    const r = openPorts({ ...full, groups: [g], classification: cls }, new Map([[61, [5200]], [60, [9000]]]), [], 1000).ports;
    expect(r.find((x) => x.port === 5200)).toMatchObject({ pid: 61, instanceKey: null, category: null, label: 'node', ageSec: 5, groupLabel: 'Claude' });
    // la racine de l'instance qui écoute elle-même : l'instance
    expect(r.find((x) => x.port === 9000)).toMatchObject({ pid: 60, instanceKey: 'claude#60:600', category: 'ai' });
  });

  it('sous-groupe de « Autres » : son propre id de groupe', () => {
    expect(info.ports.find((p) => p.port === 631)).toMatchObject({ pid: 50, groupId: 'cron', instanceKey: null });
  });

  it('port d\'un autre utilisateur : dans otherUsers (dédoublonné), jamais dans ports', () => {
    expect(info.otherUsers).toEqual([{ port: 22, uid: 0 }, { port: 5432, uid: 965 }]);
    expect(info.ports.some((p) => p.port === 5432 || p.port === 22)).toBe(false);
  });

  it('port écouté par deux pids (fork) : deux lignes ; tri par port puis pid', () => {
    expect(info.ports.filter((p) => p.port === 8080).map((p) => p.pid)).toEqual([40, 41]);
    expect(info.ports.map((p) => p.port)).toEqual([631, 3000, 8080, 8080, 9229, 41000]);
  });

  it('pid inconnu du snapshot (disparu) : ignoré', () => {
    expect(openPorts(full, new Map([[999, [7000]]]), [], 1000)).toEqual({ ports: [], otherUsers: [] });
  });

  it('protection : instance ou groupe protégé', () => {
    const prot = openPorts({ ...full, groups: [{ ...groups[1]!, protected: true }] }, byPid, [], 1000);
    expect(prot.ports.every((p) => p.protected)).toBe(true);
  });
});

describe('portMatches', () => {
  const info = openPorts(full, new Map([[20, [3000]], [40, [8080]], [41, [8080]], [50, [631]]]), [{ inode: 6, port: 5432, uid: 965 }], 1000);
  it('groupes qui écoutent ce port (dédoublonnés)', () => {
    expect(portMatches(info, 3000)).toEqual({ groupIds: ['acme'], otherUsers: [] });
    expect(portMatches(info, 8080)).toEqual({ groupIds: ['beta'], otherUsers: [] });
    expect(portMatches(info, 631).groupIds).toEqual(['cron']);
  });
  it('port d\'un autre utilisateur : aucun groupe, otherUsers non vide', () => {
    expect(portMatches(info, 5432)).toEqual({ groupIds: [], otherUsers: [{ port: 5432, uid: 965 }] });
  });
  it('port libre : vide', () => {
    expect(portMatches(info, 1)).toEqual({ groupIds: [], otherUsers: [] });
  });
});
