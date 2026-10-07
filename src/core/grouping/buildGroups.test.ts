// src/core/grouping/buildGroups.test.ts
import { describe, expect, test } from 'vitest';
import type { Group, ProcInfo } from '../types';
import { buildGroups, type GroupingOptions } from './buildGroups';

let nextStart = 0;
const proc = (p: Partial<ProcInfo> & { pid: number; name: string }): ProcInfo => ({
  ppid: 1, cmdline: p.name, uid: 1000, startTicks: nextStart++, ageSec: 100, cpuTicks: 0, cpuPercent: 0,
  rssKB: 200 * 1024, swapKB: 0, cwd: '/', cwdDeleted: false, ...p,
});

const opts = (o: Partial<GroupingOptions> = {}): GroupingOptions => ({
  home: '/home/u',
  currentUid: 1000,
  isProtected: (n) => ['zsh', 'warp', 'claude'].includes(n),
  othersThreshold: { memMB: 100, cpuPercent: 1 },
  projectRootOf: (cwd) => (cwd.startsWith('/home/u/proj') ? '/home/u/proj' : null),
  ...o,
});

const byId = (groups: Group[], id: string) => groups.find((g) => g.id === id)!;

describe('règle 1 : sessions Claude', () => {
  test('un groupe, une racine par claude de premier niveau, descendants rattachés', () => {
    const groups = buildGroups([
      proc({ pid: 10, name: 'warp' }),
      proc({ pid: 11, name: 'zsh', ppid: 10 }),
      proc({ pid: 20, name: 'claude', ppid: 11 }),
      proc({ pid: 21, name: 'node', ppid: 20, cwd: '/home/u/proj', cmdline: 'node playwright-mcp' }),
      proc({ pid: 22, name: 'claude', ppid: 20 }),
      proc({ pid: 30, name: 'claude', ppid: 11 }),
    ], opts());
    const claude = byId(groups, 'claude');
    expect(claude.roots.map((r) => r.proc.pid).sort()).toEqual([20, 30]);
    expect(claude.procCount).toBe(4);
    expect(claude.protected).toBe(true);
    expect(claude.rootName).toBe('claude');
  });
});

describe('règle 2 : applis multi-processus', () => {
  test('Chrome : un groupe avec tous ses descendants', () => {
    const groups = buildGroups([
      proc({ pid: 100, name: 'chrome', ppid: 1 }),
      proc({ pid: 101, name: 'chrome', ppid: 100 }),
      proc({ pid: 102, name: 'chrome', ppid: 101 }),
    ], opts());
    const chrome = byId(groups, 'app:chrome');
    expect(chrome.label).toBe('Chrome');
    expect(chrome.procCount).toBe(3);
    expect(chrome.roots).toHaveLength(1);
    expect(chrome.roots[0].children[0].children[0].proc.pid).toBe(102);
  });

  test('un vite lancé depuis un zsh de Warp va dans son projet, pas dans Warp', () => {
    const groups = buildGroups([
      proc({ pid: 10, name: 'warp' }),
      proc({ pid: 11, name: 'zsh', ppid: 10 }),
      proc({ pid: 12, name: 'node', ppid: 11, cwd: '/home/u/proj/front' }),
      proc({ pid: 13, name: 'esbuild', ppid: 12, cwd: '/home/u/proj/front' }),
    ], opts());
    expect(byId(groups, 'app:warp').pids.sort()).toEqual([10, 11]);
    const project = byId(groups, 'project:/home/u/proj');
    expect(project.pids.sort()).toEqual([12, 13]);
    expect(project.tags).toEqual(['node', 'esbuild']);
    expect(project.roots).toHaveLength(1);
  });
});

describe('règle 3 : outils de dev', () => {
  test('dossier supprimé → groupe dédié', () => {
    const groups = buildGroups([proc({ pid: 5, name: 'node-MainThread', cwd: '/home/u/old', cwdDeleted: true, cpuPercent: 99 })], opts());
    expect(byId(groups, 'deleted')).toMatchObject({ kind: 'deleted', label: '(dossier supprimé)' });
  });

  test('cwd illisible → groupe par nom de commande', () => {
    const groups = buildGroups([proc({ pid: 5, name: 'python3', cwd: null })], opts());
    expect(byId(groups, 'command:python3').kind).toBe('command');
  });

  test('pas de racine de projet → le dossier lui-même', () => {
    const groups = buildGroups([proc({ pid: 5, name: 'node', cwd: '/tmp/scratch' })], opts());
    expect(byId(groups, 'project:/tmp/scratch').label).toBe('tmp / scratch');
  });
});

describe('règle 4 et totaux', () => {
  test('le reste est groupé par nom, totaux et ancienneté calculés', () => {
    const groups = buildGroups([
      proc({ pid: 1, name: 'mariadbd', rssKB: 100_000, swapKB: 50_000, cpuPercent: 2, ageSec: 50 }),
      proc({ pid: 2, name: 'mariadbd', rssKB: 200_000, swapKB: 0, cpuPercent: 3, ageSec: 900 }),
    ], opts());
    expect(byId(groups, 'command:mariadbd')).toMatchObject({ procCount: 2, rssKB: 300_000, swapKB: 50_000, cpuPercent: 5, oldestAgeSec: 900 });
  });

  test('killable seulement si au moins un processus appartient à l\'utilisateur', () => {
    const groups = buildGroups([proc({ pid: 1, name: 'apache2', uid: 33 })], opts());
    expect(byId(groups, 'command:apache2').killable).toBe(false);
  });

  test('tri par RAM + swap décroissant', () => {
    const groups = buildGroups([
      proc({ pid: 1, name: 'small', rssKB: 150 * 1024 }),
      proc({ pid: 2, name: 'big', rssKB: 900 * 1024 }),
    ], opts());
    expect(groups.map((g) => g.id)).toEqual(['command:big', 'command:small']);
  });
});

describe('carte « Autres »', () => {
  test('les petits groupes sont rassemblés, en dernier', () => {
    const groups = buildGroups([
      proc({ pid: 1, name: 'big', rssKB: 500 * 1024 }),
      proc({ pid: 2, name: 'tiny1', rssKB: 1024 }),
      proc({ pid: 3, name: 'tiny2', rssKB: 2048 }),
      proc({ pid: 4, name: 'busy', rssKB: 1024, cpuPercent: 5 }),
    ], opts());
    expect(groups.map((g) => g.id)).toEqual(['command:big', 'command:busy', 'others']);
    const others = groups[2];
    expect(others.label).toBe('Autres (2 groupes)');
    expect(others.subgroups.map((g) => g.id)).toEqual(['command:tiny2', 'command:tiny1']);
    expect(others.pids.sort()).toEqual([2, 3]);
  });

  test('un seul petit groupe → pas de carte Autres', () => {
    const groups = buildGroups([proc({ pid: 1, name: 'big', rssKB: 500 * 1024 }), proc({ pid: 2, name: 'tiny', rssKB: 1 })], opts());
    expect(groups.find((g) => g.id === 'others')).toBeUndefined();
  });
});
