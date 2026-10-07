import { describe, expect, test } from 'vitest';
import type { Group, ProcInfo, SystemInfo } from '../../core/types';
import {
  findGroup, ipcErrorMessage, killErrorMessage, killRequestForGroup, killRequestForProc, pressureLevel, trackKills, visibleGroups,
} from './viewModel';

const proc = (pid: number, name: string, extra: Partial<ProcInfo> = {}): ProcInfo => ({
  pid, ppid: 1, name, cmdline: name, uid: 1000, startTicks: 0, ageSec: 10, cpuTicks: 0, cpuPercent: 0,
  rssKB: 0, swapKB: 0, cwd: null, cwdDeleted: false, ...extra,
});

const group = (id: string, procs: ProcInfo[], extra: Partial<Group> = {}): Group => ({
  id, kind: 'command', label: id, tags: [], rootName: procs[0]?.name ?? '', roots: procs.map((p) => ({ proc: p, children: [] })),
  pids: procs.map((p) => p.pid), procCount: procs.length, cpuPercent: 0, rssKB: 0, swapKB: 0, oldestAgeSec: 10,
  protected: false, killable: true, subgroups: [], ...extra,
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

  test('recherche dans libellé, commande, dossier et sous-groupes', () => {
    expect(visibleGroups(groups, { query: 'GTIX3', sort: 'mem', minAgeSec: 0 }).map((g) => g.id)).toEqual(['a']);
    expect(visibleGroups(groups, { query: 'cron', sort: 'mem', minAgeSec: 0 }).map((g) => g.id)).toEqual(['others']);
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

describe('pressureLevel', () => {
  const sys = (swapUsedPct: number, psi: number | null): SystemInfo => ({
    memTotalKB: 100, memAvailableKB: 50, swapTotalKB: 100, swapFreeKB: 100 - swapUsedPct, load1: 1, psiSome10: psi,
  });
  test.each([
    [10, 0, 'ok'], [50, 0, 'warn'], [70, 0, 'bad'], [0, 10, 'warn'], [0, 25, 'bad'], [0, null, 'ok'],
  ])('swap %i %%, PSI %s → %s', (swap, psi, level) => {
    expect(pressureLevel(sys(swap, psi))).toBe(level);
  });
  test('pas de swap → ok', () => {
    expect(pressureLevel({ ...sys(0, 0), swapTotalKB: 0, swapFreeKB: 0 })).toBe('ok');
  });
});

describe('requêtes de kill', () => {
  const isProtected = (n: string) => n === 'zsh';

  test('groupe : toujours une confirmation, processus protégés listés', () => {
    const g = group('w', [proc(1, 'warp'), proc(2, 'zsh')], { label: 'Warp' });
    const r = killRequestForGroup(g, isProtected, 1000);
    expect(r).toMatchObject({ pids: [1, 2], needsConfirm: true, title: 'Tuer 2 processus « Warp » ?' });
    expect(r.protectedProcs.map((p) => p.pid)).toEqual([2]);
  });

  test('groupe : ne cible que les processus de l\'utilisateur', () => {
    const g = group('a', [proc(1, 'apache2', { uid: 33 }), proc(2, 'apache2')]);
    expect(killRequestForGroup(g, isProtected, 1000).pids).toEqual([2]);
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
