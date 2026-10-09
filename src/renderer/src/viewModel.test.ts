import { describe, expect, test } from 'vitest';
import type { GroupSummary, InstanceSummary, ProcInfo, SystemInfo } from '../../core/types';
import {
  findGroup, ipcErrorMessage, sortForTile, killErrorMessage, killResultMessages, killRequestForGroup, killRequestForInstance, killRequestForProc, pressureLevel, trackKills, visibleGroups,
} from './viewModel';

const proc = (pid: number, name: string, extra: Partial<ProcInfo> = {}): ProcInfo => ({
  pid, ppid: 1, name, cmdline: name, uid: 1000, startTicks: 0, ageSec: 10, cpuTicks: 0, cpuPercent: 0,
  rssKB: 0, swapKB: 0, cwd: null, cwdDeleted: false, ...extra,
});

const group = (id: string, procs: ProcInfo[], extra: Partial<GroupSummary> = {}): GroupSummary => ({
  id, kind: 'command', label: id, tags: [], rootName: procs[0]?.name ?? '',
  pids: procs.map((p) => p.pid), procCount: procs.length, cpuPercent: 0, rssKB: 0, swapKB: 0, oldestAgeSec: 10,
  protected: false, killable: true, subgroups: [], categories: [], instances: [], ...extra,
});

describe('tri depuis les tuiles du haut', () => {
  test('chaque tuile donne son tri ; recliquer la tuile active revient au tri mémoire', () => {
    expect(sortForTile('mem', 'cpu')).toBe('mem');
    expect(sortForTile('swap', 'mem')).toBe('swap');
    expect(sortForTile('psi', 'cpu')).toBe('mem');
    expect(sortForTile('load', 'mem')).toBe('cpu');
    expect(sortForTile('swap', 'swap')).toBe('mem');
    expect(sortForTile('load', 'cpu')).toBe('mem');
  });
  test('tri par swap', () => {
    const g = (id: string, swapKB: number) => ({ id, label: id, kind: 'app', rssKB: 100_000 - swapKB, swapKB, cpuPercent: 0, oldestAgeSec: 10, subgroups: [] }) as unknown as GroupSummary;
    expect(visibleGroups([g('a', 10), g('b', 500), g('c', 0)], { query: '', sort: 'swap', minAgeSec: 0 }).map((x) => x.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('visibleGroups', () => {
  const groups = [
    group('a', [proc(1, 'vite', { cwd: '/home/u/acme' })], { rssKB: 100, oldestAgeSec: 90000, cpuPercent: 1 }),
    group('b', [proc(2, 'chrome')], { rssKB: 900, oldestAgeSec: 50, cpuPercent: 50 }),
    group('others', [], { kind: 'others', rssKB: 5000, oldestAgeSec: 99999, subgroups: [group('c', [proc(3, 'cron')])] }),
  ];

  test('tri mémoire, Autres toujours en dernier', () => {
    expect(visibleGroups(groups, { query: '', sort: 'mem', minAgeSec: 0 }).map((g) => g.id)).toEqual(['b', 'a', 'others']);
  });

  test('tri CPU et ancienneté', () => {
    expect(visibleGroups(groups, { query: '', sort: 'cpu', minAgeSec: 0 }).map((g) => g.id)).toEqual(['b', 'a', 'others']);
    expect(visibleGroups(groups, { query: '', sort: 'age', minAgeSec: 0 }).map((g) => g.id)).toEqual(['a', 'b', 'others']);
  });

  test('recherche : ne garde que les ids retenus côté main', () => {
    expect(visibleGroups(groups, { query: 'ACME', sort: 'mem', minAgeSec: 0 }, new Set(['a'])).map((g) => g.id)).toEqual(['a']);
    expect(visibleGroups(groups, { query: 'cron', sort: 'mem', minAgeSec: 0 }, new Set(['others'])).map((g) => g.id)).toEqual(['others']);
    expect(visibleGroups(groups, { query: 'zzz', sort: 'mem', minAgeSec: 0 }, new Set()).map((g) => g.id)).toEqual([]);
  });

  test('ordre précédent gardé tant que l\'écart de mémoire reste sous la tolérance', () => {
    const near = [group('x', [], { rssKB: 100_000 }), group('y', [], { rssKB: 102_000 })];
    const f = { query: '', sort: 'mem' as const, minAgeSec: 0 };
    expect(visibleGroups(near, f).map((g) => g.id)).toEqual(['y', 'x']);
    expect(visibleGroups(near, f, null, ['x', 'y']).map((g) => g.id)).toEqual(['x', 'y']);
    expect(visibleGroups([near[0]!, group('y', [], { rssKB: 300_000 })], f, null, ['x', 'y']).map((g) => g.id)).toEqual(['y', 'x']);
    // tri par nom : jamais de tolérance
    expect(visibleGroups(near, { ...f, sort: 'name' }, null, ['y', 'x']).map((g) => g.id)).toEqual(['x', 'y']);
  });

  test('filtre d\'ancienneté', () => {
    expect(visibleGroups(groups, { query: '', sort: 'mem', minAgeSec: 86400 }).map((g) => g.id)).toEqual(['a', 'others']);
  });
});

test('findGroup cherche aussi dans les sous-groupes', () => {
  const inner = group('c', [proc(3, 'cron')]);
  expect(findGroup([group('others', [], { subgroups: [inner] })], 'c')).toBe(inner);
  expect(findGroup([], 'x')).toBeUndefined();
});

test('pressureLevel réexporté depuis core/pressure', () => {
  expect(pressureLevel({ memTotalKB: 100, memAvailableKB: 50, swapTotalKB: 100, swapFreeKB: 20, load1: 1, psiSome10: 0, shmemKB: 0 })).toBe('bad');
});

describe('requêtes de kill', () => {
  const isProtected = (n: string) => n === 'zsh';

  test('groupe : toujours une confirmation, processus protégés listés', () => {
    const procs = [proc(1, 'warp'), proc(2, 'zsh')];
    const r = killRequestForGroup(group('w', procs, { label: 'Warp' }), procs, isProtected, 1000);
    expect(r).toMatchObject({ targets: [{ pid: 1, startTicks: 0 }, { pid: 2, startTicks: 0 }], needsConfirm: true, title: 'Tuer 2 processus « Warp » ?' });
    expect(r.protectedProcs.map((p) => p.pid)).toEqual([2]);
  });

  test('groupe : enfants d\'abord (les lots de 2 000 gardent l\'ordre du handler kill)', () => {
    const procs = [proc(10, 'npm', { ppid: 1 }), proc(11, 'node', { ppid: 10 }), proc(12, 'esbuild', { ppid: 11 }), proc(13, 'node', { ppid: 10 })];
    expect(killRequestForGroup(group('g', procs), procs, isProtected, 1000).targets.map((t) => t.pid)).toEqual([12, 11, 13, 10]);
  });

  test('groupe : ne cible que les processus de l\'utilisateur', () => {
    const procs = [proc(1, 'apache2', { uid: 33 }), proc(2, 'apache2')];
    expect(killRequestForGroup(group('a', procs), procs, isProtected, 1000).targets).toEqual([{ pid: 2, startTicks: 0 }]);
  });

  test('processus seul : cible = pid + startTicks', () => {
    expect(killRequestForProc(proc(5, 'node', { startTicks: 4242 }), isProtected, 1000).targets).toEqual([{ pid: 5, startTicks: 4242 }]);
  });

  test('processus seul : confirmation seulement s\'il est protégé', () => {
    expect(killRequestForProc(proc(5, 'node'), isProtected, 1000).needsConfirm).toBe(false);
    expect(killRequestForProc(proc(6, 'zsh'), isProtected, 1000).needsConfirm).toBe(true);
  });
});

describe('trackKills', () => {
  test('bloqué après 3 s s\'il est encore présent, retiré s\'il a disparu', () => {
    const pending = new Map([[1, 0], [2, 0], [3, 2500]]);
    const r = trackKills(pending, new Set([1, 3]), 3000);
    expect([...r.stuck]).toEqual([1]);
    expect([...r.pending.keys()]).toEqual([1, 3]);
  });
});

test('killErrorMessage', () => {
  expect(killErrorMessage({ pid: 1, ok: true })).toBeNull();
  expect(killErrorMessage({ pid: 1, ok: false, error: 'ESRCH' })).toBeNull();
  expect(killErrorMessage({ pid: 1, ok: false, error: 'EPERM' })).toBe('PID 1 : permission refusée');
  expect(killErrorMessage({ pid: 1, ok: false, error: 'SELF' })).toBe('PID 1 : refusé, c\'est proc-watch ou l\'un de ses parents');
});

describe('ipcErrorMessage', () => {
  test('retire le préfixe IPC d\'Electron', () => {
    expect(ipcErrorMessage(new Error("Error invoking remote method 'desktop:install': Error: Disponible uniquement dans la version installée (AppImage ou .deb)")))
      .toBe('Disponible uniquement dans la version installée (AppImage ou .deb)');
  });
  test('Error simple', () => expect(ipcErrorMessage(new Error('x'))).toBe('x'));
  test('valeur non Error', () => expect(ipcErrorMessage('boom')).toBe('boom'));
});

describe('killResultMessages', () => {
  test('aucun message pour les succès et ESRCH', () => {
    expect(killResultMessages([{ pid: 1, ok: true }, { pid: 2, ok: false, error: 'ESRCH' }])).toEqual([]);
  });
  test('une seule erreur → message détaillé', () => {
    expect(killResultMessages([{ pid: 3, ok: false, error: 'EPERM' }])).toEqual(['PID 3 : permission refusée']);
  });
  test('plusieurs SELF → un seul toast', () => {
    const rs = [1, 2, 3].map((pid) => ({ pid, ok: false, error: 'SELF' }));
    expect(killResultMessages(rs)).toEqual(['3 processus refusés : c\'est proc-watch ou l\'un de ses parents']);
  });
  test('plusieurs EPERM + un autre code → un toast par type d\'erreur', () => {
    const rs = [{ pid: 1, ok: false, error: 'EPERM' }, { pid: 2, ok: false, error: 'EPERM' }, { pid: 3, ok: false, error: 'EIO' }];
    expect(killResultMessages(rs)).toEqual(['2 processus : permission refusée', 'PID 3 : EIO']);
  });
});

describe('killRequestForInstance', () => {
  const inst = (extra: Partial<InstanceSummary> = {}): InstanceSummary => ({
    key: 'g#1:1', groupId: 'g', project: '/p', category: 'back', source: 'command', signature: 'nest start', label: 'nest start', rootPid: 1, rootStartTicks: 1,
    pids: [1, 2], ports: [3000], ageSec: 100, rssKB: 1000, swapKB: 0, cpuPercent: 0, duplicate: false, protected: false, ...extra,
  });
  const isProtected = (n: string) => n === 'zsh';
  test('cibles = processus de l\'utilisateur parmi les cibles du main ; pas de confirmation sans protégé', () => {
    const procs = [proc(1, 'node', { startTicks: 1 }), proc(2, 'node', { startTicks: 2, uid: 33 }), proc(9, 'other')];
    const r = killRequestForInstance(inst(), [{ pid: 1, startTicks: 1 }, { pid: 2, startTicks: 2 }], procs, isProtected, 1000);
    expect(r).toMatchObject({ targets: [{ pid: 1, startTicks: 1 }], needsConfirm: false, title: 'Tuer l\'instance « nest start » (1 processus) ?' });
    expect(r.protectedProcs).toEqual([]);
  });
  test('confirmation si l\'instance est protégée ; les processus protégés sont listés', () => {
    const procs = [proc(1, 'zsh', { startTicks: 1 }), proc(2, 'node', { startTicks: 2 })];
    const r = killRequestForInstance(inst({ protected: true }), [{ pid: 1, startTicks: 1 }, { pid: 2, startTicks: 2 }], procs, isProtected, 1000);
    expect(r.needsConfirm).toBe(true);
    expect(r.protectedProcs.map((p) => p.pid)).toEqual([1]);
    expect(r.title).toBe('Tuer l\'instance « nest start » (2 processus) ?');
  });
  test('cible dont le processus a changé (startTicks) ou disparu : écartée', () => {
    const procs = [proc(1, 'node', { startTicks: 5 })];
    expect(killRequestForInstance(inst(), [{ pid: 1, startTicks: 1 }, { pid: 2, startTicks: 2 }], procs, isProtected, 1000).targets).toEqual([]);
  });
});
