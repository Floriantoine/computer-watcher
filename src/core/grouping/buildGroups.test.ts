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

  test('keepSeparate : un petit groupe encore « collant » garde sa carte', () => {
    const groups = buildGroups([
      proc({ pid: 1, name: 'big', rssKB: 500 * 1024 }),
      proc({ pid: 2, name: 'tiny1', rssKB: 1024 }),
      proc({ pid: 3, name: 'tiny2', rssKB: 2048 }),
      proc({ pid: 4, name: 'tiny3', rssKB: 512 }),
    ], opts({ keepSeparate: (id) => id === 'command:tiny1' }));
    expect(groups.map((g) => g.id)).toEqual(['command:big', 'command:tiny1', 'others']);
    expect(byId(groups, 'others').subgroups.map((g) => g.id)).toEqual(['command:tiny2', 'command:tiny3']);
  });

  test('un projet ou un dossier supprimé n\'est jamais rangé dans « Autres », même petit et inactif', () => {
    const groups = buildGroups([
      proc({ pid: 1, name: 'node', rssKB: 5 * 1024, cwd: '/home/u/proj', cmdline: 'node server.js' }),
      proc({ pid: 2, name: 'node', rssKB: 3 * 1024, cwd: '/gone', cwdDeleted: true }),
      proc({ pid: 3, name: 'tiny1', rssKB: 1024 }),
      proc({ pid: 4, name: 'tiny2', rssKB: 2048 }),
    ], opts());
    expect(groups.map((g) => g.id)).toEqual(['project:/home/u/proj', 'deleted', 'others']);
    expect(byId(groups, 'others').subgroups.map((g) => g.id)).toEqual(['command:tiny2', 'command:tiny1']);
  });

  test('exemption réservée aux vraies racines de projet : dossier personnel et / suivent le seuil', () => {
    const groups = buildGroups([
      proc({ pid: 1, name: 'node', rssKB: 5 * 1024, cwd: '/home/u' }),
      proc({ pid: 2, name: 'node', rssKB: 4 * 1024, cwd: '/' }),
      proc({ pid: 3, name: 'node', rssKB: 3 * 1024, cwd: '/home/u/proj' }),
    ], opts({ projectRootOf: (cwd) => (cwd.startsWith('/home/u/proj') ? '/home/u/proj' : cwd === '/' ? '/' : null) }));
    expect(groups.map((g) => g.id)).toEqual(['project:/home/u/proj', 'others']);
    expect(byId(groups, 'others').subgroups.map((g) => g.id)).toEqual(['project:/home/u', 'project:/']);
  });

  test('un seul petit groupe → pas de carte Autres', () => {
    const groups = buildGroups([proc({ pid: 1, name: 'big', rssKB: 500 * 1024 }), proc({ pid: 2, name: 'tiny', rssKB: 1 })], opts());
    expect(groups.find((g) => g.id === 'others')).toBeUndefined();
  });
});

test('cycle de ppid : le groupe est quand même construit', () => {
  const groups = buildGroups([
    proc({ pid: 70, name: 'node', ppid: 71, cwd: '/home/u/proj' }),
    proc({ pid: 71, name: 'node', ppid: 70, cwd: '/home/u/proj' }),
  ], opts());
  const g = byId(groups, 'project:/home/u/proj');
  expect(g.procCount).toBe(2);
  expect(g.roots.length).toBeGreaterThan(0);
});

describe('règle 1 bis : outils Claude détachés (dossier de travail sous ~/.claude)', () => {
  const PLUGIN = '/home/u/.claude/plugins/cache/superpowers/6.4.1';
  const detached = () => [
    proc({ pid: 1500, name: 'systemd', cmdline: '/usr/lib/systemd/systemd --user', cwd: '/home/u' }),
    proc({ pid: 4000, name: 'node', ppid: 1500, cmdline: 'node server.cjs', cwd: PLUGIN }),
    proc({ pid: 4001, name: 'node', ppid: 4000, cmdline: 'node worker.js', cwd: '/tmp' }),
  ];
  const claudeDirs = ['/home/u/.claude'];

  test('node server.cjs (parent systemd --user) et son enfant → groupe Claude, aucun projet', () => {
    const groups = buildGroups(detached(), opts({ claudeDirs }));
    const claude = byId(groups, 'claude');
    expect(claude).toMatchObject({ kind: 'claude', label: 'Claude' });
    expect(claude.pids.sort()).toEqual([4000, 4001]);
    expect(groups.some((g) => g.kind === 'project')).toBe(false);
  });

  test('sans claudeDirs : comportement actuel (carte projet « 6.4.1 »)', () => {
    const groups = buildGroups(detached(), opts());
    expect(byId(groups, `project:${PLUGIN}`).pids).toEqual([4000]);
    expect(byId(groups, 'project:/tmp').pids).toEqual([4001]); // l'enfant suit son propre dossier
    expect(groups.some((g) => g.id === 'claude')).toBe(false);
  });

  test('dossier de travail supprimé : pas déplacé', () => {
    const procs = detached().map((p) => (p.pid === 4000 ? { ...p, cwdDeleted: true } : p));
    const groups = buildGroups(procs, opts({ claudeDirs }));
    expect(groups.some((g) => g.id === 'claude')).toBe(false);
  });

  test('une vraie session claude et l\'outil détaché : un seul groupe Claude', () => {
    const groups = buildGroups([
      ...detached(),
      proc({ pid: 20, name: 'claude', ppid: 1500, cwd: '/home/u/proj' }),
      proc({ pid: 21, name: 'node', ppid: 20, cwd: '/home/u/proj', cmdline: 'node mcp' }),
    ], opts({ claudeDirs }));
    const claude = groups.filter((g) => g.id === 'claude');
    expect(claude).toHaveLength(1);
    expect(claude[0]!.pids.sort((a, b) => a - b)).toEqual([20, 21, 4000, 4001]);
    expect(claude[0]!.roots.map((r) => r.proc.pid).sort((a, b) => a - b)).toEqual([20, 4000]);
  });

  test('arbre d\'une appli : warp → zsh (cwd ~/.claude) → vim reste dans app:warp', () => {
    const groups = buildGroups([
      ...detached(),
      proc({ pid: 60, name: 'warp', ppid: 1500, cwd: '/home/u' }),
      proc({ pid: 61, name: 'zsh', ppid: 60, cwd: '/home/u/.claude' }),
      proc({ pid: 62, name: 'vim', ppid: 61, cwd: '/home/u/.claude' }),
    ], opts({ claudeDirs }));
    expect(byId(groups, 'app:warp').pids.sort((a, b) => a - b)).toEqual([60, 61, 62]);
    // l'outil détaché (parent systemd --user) va toujours dans Claude
    expect(byId(groups, 'claude').pids.sort((a, b) => a - b)).toEqual([4000, 4001]);
  });

  test('groupe Claude sans session claude : nom racine « claude » (jamais « Protéger « node » »)', () => {
    const groups = buildGroups(detached(), opts({ claudeDirs }));
    expect(byId(groups, 'claude').rootName).toBe('claude');
  });

  test('un processus sous ~/.claude-backup reste où il était', () => {
    const groups = buildGroups([proc({ pid: 50, name: 'node', cwd: '/home/u/.claude-backup/x' })], opts({ claudeDirs }));
    expect(groups.some((g) => g.id === 'claude')).toBe(false);
  });
});

describe('règle 1 ter : outils de dev lancés par Claude dans un projet', () => {
  const claudeDirs = ['/home/u/.claude'];
  const roots: Record<string, string> = { '/home/u/acme/backend': '/home/u/acme/backend', '/home/u/beta': '/home/u/beta', '/home/u': '/home/u' };
  const projectRootOf = (cwd: string): string | null => {
    for (let d = cwd; d && d !== '/'; d = d.slice(0, d.lastIndexOf('/')) || '/') if (roots[d]) return roots[d];
    if (cwd.startsWith('/home/u/.claude/plugins/')) return '/home/u/.claude/plugins/cache/x';
    return null;
  };
  const o = opts({ claudeDirs, projectRootOf });
  const session = (...rest: ProcInfo[]): ProcInfo[] => [
    proc({ pid: 10, name: 'warp' }),
    proc({ pid: 11, name: 'zsh', ppid: 10, cwd: '/home/u/acme/backend' }),
    proc({ pid: 20, name: 'claude', ppid: 11, cwd: '/home/u/acme/backend', rssKB: 400 * 1024 }),
    ...rest,
  ];

  test('claude → zsh -c → npx jest : jest et npx vont dans le projet, marqués lancés par Claude ; zsh reste dans Claude', () => {
    const groups = buildGroups(session(
      proc({ pid: 30, name: 'zsh', ppid: 20, cwd: '/home/u/acme/backend', cmdline: '/usr/bin/zsh -c source /home/u/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval npx jest' }),
      proc({ pid: 31, name: 'npm exec jest', ppid: 30, cwd: '/home/u/acme/backend', cmdline: 'npm exec jest' }),
      proc({ pid: 32, name: 'node', ppid: 31, cwd: '/home/u/acme/backend', cmdline: 'node /home/u/acme/backend/node_modules/.bin/jest', rssKB: 300 * 1024 }),
    ), o);
    const claude = byId(groups, 'claude');
    expect(claude.pids.sort()).toEqual([20, 30]);
    const project = byId(groups, 'project:/home/u/acme/backend');
    expect(project.pids.sort()).toEqual([31, 32]);
    expect(project.launchedByClaude?.sort()).toEqual([31, 32]);
  });

  test('le total de Claude n’inclut plus les processus déplacés', () => {
    const groups = buildGroups(session(
      proc({ pid: 30, name: 'zsh', ppid: 20, cwd: '/home/u/beta', rssKB: 10 * 1024 }),
      proc({ pid: 31, name: 'node', ppid: 30, cwd: '/home/u/beta', cmdline: 'node node_modules/.bin/vite', rssKB: 500 * 1024 }),
    ), o);
    expect(byId(groups, 'claude').rssKB).toBe(410 * 1024);
    expect(byId(groups, 'project:/home/u/beta').rssKB).toBe(500 * 1024);
    const all = groups.flatMap((g) => [g, ...g.subgroups]).filter((g) => g.kind !== 'others');
    expect(all.flatMap((g) => g.pids).filter((p) => p === 31)).toHaveLength(1);
  });

  test('serveur MCP (node mcp-server-fs, npx context7-mcp) dans le projet : reste dans Claude, enfants compris', () => {
    const groups = buildGroups(session(
      proc({ pid: 30, name: 'node', ppid: 20, cwd: '/home/u/acme/backend', cmdline: 'node /home/u/.npm/_npx/a/node_modules/.bin/mcp-server-fs /home/u/acme' }),
      proc({ pid: 31, name: 'npm exec @upst', ppid: 20, cwd: '/home/u/acme/backend', cmdline: 'npm exec @upstash/context7-mcp' }),
      proc({ pid: 32, name: 'node', ppid: 31, cwd: '/home/u/acme/backend', cmdline: 'node /home/u/.npm/_npx/b/node_modules/.bin/context7-mcp' }),
      proc({ pid: 33, name: 'node', ppid: 20, cwd: '/home/u/acme/backend', cmdline: 'node /home/u/.npm/_npx/c/node_modules/@playwright/mcp/cli.js' }),
      proc({ pid: 34, name: 'node', ppid: 33, cwd: '/home/u/acme/backend', cmdline: 'node helper.js' }),
    ), o);
    expect(byId(groups, 'claude').pids.sort()).toEqual([20, 30, 31, 32, 33, 34]);
    expect(groups.find((g) => g.id.startsWith('project:'))).toBeUndefined();
  });

  test('node lancé depuis le dossier personnel : reste dans Claude', () => {
    const groups = buildGroups(session(proc({ pid: 30, name: 'node', ppid: 20, cwd: '/home/u', cmdline: 'node -e 1' })), o);
    expect(byId(groups, 'claude').pids).toContain(30);
  });

  test('node sous ~/.claude/plugins (outil de plugin) : reste dans Claude', () => {
    const groups = buildGroups(session(proc({ pid: 30, name: 'node', ppid: 20, cwd: '/home/u/.claude/plugins/cache/x/server', cmdline: 'node server.cjs' })), o);
    expect(byId(groups, 'claude').pids).toContain(30);
  });

  test('script d’outil Claude (ligne de commande sous ~/.claude) lancé dans le projet : reste dans Claude', () => {
    const groups = buildGroups(session(proc({ pid: 30, name: 'node', ppid: 20, cwd: '/home/u/beta', cmdline: 'node /home/u/.claude/plugins/cache/x/hooks/run.js' })), o);
    expect(byId(groups, 'claude').pids).toContain(30);
  });

  test('outil non-dev (git, rg) dans le projet : reste dans Claude', () => {
    const groups = buildGroups(session(proc({ pid: 30, name: 'rg', ppid: 20, cwd: '/home/u/beta', cmdline: 'rg foo' })), o);
    expect(byId(groups, 'claude').pids).toContain(30);
  });

  test('dossier supprimé : le processus part dans « dossier supprimé », marqué', () => {
    const groups = buildGroups(session(proc({ pid: 30, name: 'node', ppid: 20, cwd: '/home/u/beta/.worktrees/x', cwdDeleted: true, cmdline: 'node vite' })), o);
    expect(byId(groups, 'deleted').pids).toEqual([30]);
    expect(byId(groups, 'deleted').launchedByClaude).toEqual([30]);
  });

  test('claude → zsh → node playwright test → chromium et ses renderers : tout le sous-arbre dans le projet, pas dans Chrome', () => {
    const B = '/home/u/beta';
    const groups = buildGroups(session(
      proc({ pid: 30, name: 'zsh', ppid: 20, cwd: B }),
      proc({ pid: 31, name: 'node', ppid: 30, cwd: B, cmdline: `node ${B}/node_modules/.bin/playwright test` }),
      proc({ pid: 32, name: 'chrome', ppid: 31, cwd: B, cmdline: '/home/u/.cache/ms-playwright/chromium-1/chrome-linux/chrome --headless' }),
      proc({ pid: 33, name: 'chrome', ppid: 32, cwd: B, cmdline: '/home/u/.cache/ms-playwright/chromium-1/chrome-linux/chrome --type=renderer' }),
      proc({ pid: 34, name: 'chrome', ppid: 32, cwd: B, cmdline: '/home/u/.cache/ms-playwright/chromium-1/chrome-linux/chrome --type=gpu-process' }),
      proc({ pid: 40, name: 'chrome', ppid: 1, cmdline: '/opt/google/chrome/chrome' }),
    ), o);
    const project = byId(groups, `project:${B}`);
    expect(project.pids.sort()).toEqual([31, 32, 33, 34]);
    expect(project.launchedByClaude?.sort()).toEqual([31, 32, 33, 34]);
    expect(byId(groups, 'app:chrome').pids).toEqual([40]);
    expect(byId(groups, 'claude').pids.sort()).toEqual([20, 30]);
  });

  test('claude → zsh → npx jest → sh -c → node worker : tout dans le projet, rien dans command:sh', () => {
    const A = '/home/u/acme/backend';
    const groups = buildGroups(session(
      proc({ pid: 30, name: 'zsh', ppid: 20, cwd: A }),
      proc({ pid: 31, name: 'npm exec jest', ppid: 30, cwd: A, cmdline: 'npm exec jest' }),
      proc({ pid: 32, name: 'sh', ppid: 31, cwd: A, cmdline: 'sh -c jest' }),
      proc({ pid: 33, name: 'node', ppid: 32, cwd: A, cmdline: `node ${A}/node_modules/.bin/jest` }),
      proc({ pid: 34, name: 'node', ppid: 33, cwd: A, cmdline: `node ${A}/node_modules/jest-worker/build/processChild.js` }),
    ), o);
    expect(byId(groups, `project:${A}`).pids.sort()).toEqual([31, 32, 33, 34]);
    expect(groups.find((g) => g.id === 'command:sh')).toBeUndefined();
    expect(byId(groups, 'claude').pids.sort()).toEqual([20, 30]);
  });

  test('serveur de dev lancé à la main (Warp → zsh → npm run dev) : pas marqué', () => {
    const groups = buildGroups([
      proc({ pid: 10, name: 'warp' }),
      proc({ pid: 11, name: 'zsh', ppid: 10, cwd: '/home/u/beta' }),
      proc({ pid: 12, name: 'npm run dev', ppid: 11, cwd: '/home/u/beta', cmdline: 'npm run dev' }),
      proc({ pid: 13, name: 'node', ppid: 12, cwd: '/home/u/beta', cmdline: 'node node_modules/.bin/vite' }),
    ], o);
    const project = byId(groups, 'project:/home/u/beta');
    expect(project.pids.sort()).toEqual([12, 13]);
    expect(project.launchedByClaude).toBeUndefined();
  });
});
