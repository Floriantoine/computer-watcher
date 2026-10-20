import { describe, expect, test } from 'vitest';
import type { ProcInfo } from '../types';
import { planMoves, type PlanMove } from './plan';

const BASE = '/user.slice/user-1000.slice/user@1000.service';
const WARP = `${BASE}/app.slice/app-dev.warp.Warp@1.service`;
const CODE = `${BASE}/app.slice/app-code-42.scope`;
const RUN = `${BASE}/app.slice/run-u77.scope`;
const MOVED = `${BASE}/cwatch.slice/cwatch-p-alpha.scope`;
const A = '/home/u/alpha';
const NM = `${A}/node_modules`;

let st = 1000;
const p = (pid: number, ppid: number, name: string, cmdline: string, o: Partial<ProcInfo> = {}): ProcInfo => ({
  pid, ppid, name, cmdline, uid: 1000, startTicks: st++, ageSec: 10, cpuTicks: 0, cpuPercent: 0, rssKB: 100_000, swapKB: 0, cwd: null, cwdDeleted: false, ...o,
});
const warp = () => [p(600, 500, 'warp', 'warp'), p(601, 600, 'zsh', 'zsh')];

function run(procs: ProcInfo[], o: { project?: Record<number, string>; cg?: Record<number, string>; protect?: string[] } = {}) {
  return planMoves({
    procs, currentUid: 1000, selfPid: 900, appRoot: null, userBase: BASE,
    projectOf: (pid) => o.project?.[pid] ?? null,
    isProtected: (n) => (o.protect ?? ['bash', 'zsh', 'sh', 'warp', 'claude']).includes(n),
    cgroupOf: (pid) => o.cg?.[pid] ?? WARP,
  });
}
const pidsOf = (m: PlanMove) => m.targets.map((t) => t.pid).sort((a, b) => a - b);

describe('qui est déplacé', () => {
  test('Warp → zsh → npm → sh → jest (comm MainThread) et ses workers : npm et tout son sous-arbre, dans le projet', () => {
    const procs = [...warp(), p(700, 601, 'npm run test', 'npm run test'), p(701, 700, 'sh', 'sh -c jest'),
      p(702, 701, 'MainThread', `node ${NM}/jest/bin/jest.js`),
      p(703, 702, 'MainThread', `node ${NM}/jest-worker/build/workers/processChild.js`),
      p(704, 702, 'MainThread', `node ${NM}/jest-worker/build/workers/processChild.js`)];
    const r = run(procs, { project: { 700: A, 702: A, 703: A, 704: A } });
    expect(r.moves).toHaveLength(1);
    expect(r.moves[0]).toMatchObject({ rootPid: 700, root: A, anchorCgroup: WARP });
    expect(r.moves[0]!.targets[0]).toEqual({ pid: 700, startTicks: procs[2]!.startTicks });
    expect(pidsOf(r.moves[0]!)).toEqual([700, 701, 702, 703, 704]);
  });

  test('Claude → shell de l’outil Bash → tsc hors projet (comm MainThread) : tsc seul, sans projet ; jamais claude ni le shell', () => {
    const procs = [...warp(), p(800, 601, 'claude', 'claude'),
      p(801, 800, 'zsh', '/bin/zsh -c source /home/u/.claude/shell-snapshots/s.sh && tsc --noEmit'),
      p(810, 801, 'MainThread', 'node /usr/lib/node_modules/typescript/bin/tsc --noEmit')];
    const r = run(procs);
    expect(r.moves.map((m) => [m.rootPid, m.root, pidsOf(m)])).toEqual([[810, null, [810]]]);
  });

  test('éditeur : le tsserver de VS Code est déplacé, jamais code', () => {
    const procs = [p(400, 1, 'code', '/usr/lib/code/code'), p(401, 400, 'node', 'node /usr/lib/code/extensions/node_modules/typescript/lib/tsserver.js')];
    const r = run(procs, { cg: { 400: CODE, 401: CODE } });
    expect(r.moves.map((m) => [m.rootPid, m.anchorCgroup, pidsOf(m)])).toEqual([[401, CODE, [401]]]);
  });

  test('ni le terminal, ni les shells, ni vim ou htop lancés dans le terminal', () => {
    const r = run([...warp(), p(620, 601, 'vim', 'vim notes.txt'), p(621, 601, 'htop', 'htop')]);
    expect(r.moves).toEqual([]);
  });

  test('processus protégé par l’utilisateur (postgres lancé du terminal) : jamais', () => {
    const r = run([...warp(), p(680, 601, 'postgres', `postgres -D ${A}/db`)], { protect: ['zsh', 'warp', 'postgres'] });
    expect(r.moves).toEqual([]);
  });

  test('autre utilisateur sous le shell : refusé « uid », jamais déplacé', () => {
    const r = run([...warp(), p(630, 601, 'sudo', 'sudo pacman -Syu', { uid: 0 }), p(631, 630, 'MainThread', `node ${NM}/vitest/vitest.mjs`, { uid: 0 })]);
    expect(r.moves).toEqual([]);
    expect(r.refused).toContainEqual({ pid: 630, reason: 'uid' });
  });

  test('déjà dans cwatch.slice : rien à faire, signalé « moved » avec son cgroup et son projet', () => {
    const r = run([...warp(), p(700, 601, 'MainThread', `node ${NM}/vitest/vitest.mjs run`)], { project: { 700: A }, cg: { 700: MOVED } });
    expect(r.moves).toEqual([]);
    expect(r.refused).toContainEqual({ pid: 700, reason: 'moved' });
    expect(r.inside).toEqual([{ pid: 700, cgroup: MOVED, root: A }]);
  });

  test('commande lancée par systemd-run --user --scope depuis le terminal : autre unité, jamais déplacée', () => {
    const procs = [...warp(), p(641, 601, 'timeout', 'timeout 900 npx vitest run'), p(642, 641, 'MainThread', `node ${NM}/vitest/vitest.mjs run`)];
    const r = run(procs, { cg: { 641: RUN, 642: RUN } });
    expect(r.moves).toEqual([]);
    expect(r.refused).toContainEqual({ pid: 642, reason: 'other-unit' });
  });

  test('hors du gestionnaire utilisateur (service système) : jamais', () => {
    const r = run([...warp(), p(650, 601, 'MainThread', `node ${NM}/vitest/vitest.mjs run`)], { cg: { 650: '/system.slice/docker.service' } });
    expect(r.moves).toEqual([]);
    expect(r.refused).toContainEqual({ pid: 650, reason: 'outside-user' });
  });

  test('terminal hors du gestionnaire utilisateur (session ssh) : rien sous lui', () => {
    const procs = [p(600, 500, 'konsole', 'konsole'), p(601, 600, 'zsh', 'zsh'), p(700, 601, 'MainThread', `node ${NM}/jest/bin/jest.js`)];
    const r = run(procs, { cg: { 600: '/user.slice/user-1000.slice/session-3.scope', 601: '/user.slice/user-1000.slice/session-3.scope', 700: '/user.slice/user-1000.slice/session-3.scope' } });
    expect(r.moves).toEqual([]);
    expect(r.refused).toContainEqual({ pid: 700, reason: 'anchor-cgroup' });
  });

  test('l’app lancée en dev depuis le terminal (npm run dev → electron …/computer-watcher) : ni l’app, ni son lanceur', () => {
    const procs = [...warp(), p(660, 601, 'npm run dev', 'npm run dev'), p(661, 660, 'sh', 'sh -c electron-vite dev'),
      p(662, 661, 'MainThread', 'node /home/u/computer-watcher/node_modules/electron-vite/bin/electron-vite.js dev'),
      p(663, 662, 'electron', '/home/u/computer-watcher/node_modules/electron/dist/electron .')];
    const r = run(procs, { project: { 660: '/home/u/computer-watcher' } });
    expect(r.moves).toEqual([]);
    expect(r.refused).toContainEqual({ pid: 660, reason: 'blocked' });
  });

  test('lanceur au-dessus d’une session Claude (npm exec claude) : ni le lanceur, ni la session', () => {
    const r = run([...warp(), p(670, 601, 'npm exec @anth', 'npm exec @anthropic-ai/claude-code'), p(671, 670, 'claude', 'claude')], { project: { 670: A } });
    expect(r.moves).toEqual([]);
    expect(r.refused).toContainEqual({ pid: 670, reason: 'blocked' });
  });

  test('un descendant dans une autre unité (lancé par systemd-run) reste où il est', () => {
    const procs = [...warp(), p(700, 601, 'MainThread', `node ${NM}/jest/bin/jest.js`), p(701, 700, 'MainThread', `node ${NM}/jest-worker/x.js`)];
    const r = run(procs, { project: { 700: A }, cg: { 701: RUN } });
    expect(r.moves.map(pidsOf)).toEqual([[700]]);
  });

  test('sans terminal, éditeur ni Claude au-dessus (lancé par systemd) : jamais', () => {
    const procs = [p(500, 1, 'systemd', 'systemd --user'), p(700, 500, 'MainThread', `node ${NM}/vite/bin/vite.js`)];
    expect(run(procs, { project: { 700: A } }).moves).toEqual([]);
  });

  test('le service lui-même (pid du service) n’est jamais déplacé, même sous un terminal', () => {
    const r = run([...warp(), p(900, 601, 'node', 'node /x/out/main/recorder.js')], { project: { 900: A } });
    expect(r.moves).toEqual([]);
  });

  test('workMemo : le classement par ligne de commande est mis en cache par pid:startTicks', () => {
    const procs = [...warp(), p(810, 601, 'MainThread', 'node /usr/lib/node_modules/typescript/bin/tsc --noEmit')];
    const memo = new Map<string, boolean>();
    const input = { procs, currentUid: 1000, selfPid: 900, appRoot: null, userBase: BASE, projectOf: () => null, isProtected: () => false, cgroupOf: () => WARP, workMemo: memo };
    expect(planMoves(input).moves).toHaveLength(1);
    expect(memo.get(`810:${procs[2]!.startTicks}`)).toBe(true);
  });
});

describe('décisions du contrôleur (A à D)', () => {
  test('A : enfant direct non-shell de Claude (serveur MCP, dans un projet) : jamais déplacé, ni son sous-arbre', () => {
    const procs = [...warp(), p(800, 601, 'claude', 'claude'),
      p(820, 800, 'MainThread', 'node /home/u/.local/lib/mcp/dist/index.js', { cwd: A }),
      p(821, 820, 'npm run test', 'npm run test', { cwd: A }),
      p(822, 821, 'MainThread', `node ${NM}/jest/bin/jest.js`, { cwd: A })];
    const r = run(procs, { project: { 820: A, 821: A, 822: A } });
    expect(r.moves).toEqual([]);
  });

  test('A : claude → zsh → jest (outil Bash) : jest est déplacé, ni claude ni le shell', () => {
    const procs = [...warp(), p(800, 601, 'claude', 'claude'),
      p(801, 800, 'zsh', '/bin/zsh -c source /home/u/.claude/shell-snapshots/s.sh && npx jest'),
      p(802, 801, 'MainThread', `node ${NM}/jest/bin/jest.js`)];
    const r = run(procs, { project: { 802: A } });
    expect(r.moves.map((m) => [m.rootPid, m.root, pidsOf(m)])).toEqual([[802, A, [802]]]);
  });

  test('A : un hook ou un LSP lancé directement par Claude (hors projet) : jamais déplacé', () => {
    const procs = [...warp(), p(800, 601, 'claude', 'claude'),
      p(830, 800, 'MainThread', 'node /usr/lib/node_modules/typescript/bin/tsc --noEmit'),
      p(831, 800, 'MainThread', 'node /usr/lib/node_modules/typescript-language-server/lib/cli.mjs --stdio')];
    expect(run(procs).moves).toEqual([]);
  });

  test('A : un terminal ou un Claude sous un serveur MCP ne sert pas d’ancre', () => {
    const procs = [...warp(), p(800, 601, 'claude', 'claude'),
      p(820, 800, 'MainThread', 'node /home/u/.local/lib/mcp/dist/index.js'),
      p(840, 820, 'kitty', 'kitty'), p(841, 840, 'zsh', 'zsh'), p(842, 841, 'MainThread', `node ${NM}/jest/bin/jest.js`)];
    expect(run(procs, { project: { 842: A } }).moves).toEqual([]);
  });

  test('B : zsh → vite --open → firefox : ni vite (racine bloquée), ni le navigateur', () => {
    const procs = [...warp(), p(700, 601, 'MainThread', `node ${NM}/vite/bin/vite.js --open`),
      p(701, 700, 'firefox', '/usr/lib/firefox/firefox http://localhost:5173/'),
      p(702, 701, 'Isolated Web Co', '/usr/lib/firefox/firefox -contentproc')];
    const r = run(procs, { project: { 700: A } });
    expect(r.moves).toEqual([]);
    expect(r.refused).toContainEqual({ pid: 700, reason: 'blocked' });
  });

  test('B : zsh → vite --open → chrome : ni vite, ni le navigateur', () => {
    const procs = [...warp(), p(700, 601, 'MainThread', `node ${NM}/vite/bin/vite.js --open`),
      p(701, 700, 'chrome', '/opt/google/chrome/chrome http://localhost:5173/'),
      p(702, 701, 'chrome', '/opt/google/chrome/chrome --type=renderer')];
    const r = run(procs, { project: { 700: A } });
    expect(r.moves).toEqual([]);
    expect(r.refused).toContainEqual({ pid: 700, reason: 'blocked' });
  });

  test('B : un navigateur de test (Playwright, headless) suit son test, comme dans le regroupement', () => {
    const procs = [...warp(), p(700, 601, 'MainThread', `node ${NM}/@playwright/test/cli.js test`),
      p(701, 700, 'chrome', '/home/u/.cache/ms-playwright/chromium-1/chrome-linux/chrome --headless')];
    const r = run(procs, { project: { 700: A } });
    expect(r.moves.map(pidsOf)).toEqual([[700, 701]]);
  });

  test('D : ppid cyclique ou égal au pid : aucune boucle, rien de déplacé hors d’une ancre', () => {
    const procs = [...warp(),
      p(710, 711, 'MainThread', `node ${NM}/jest/bin/jest.js`), p(711, 710, 'MainThread', `node ${NM}/jest/bin/jest.js`),
      p(712, 712, 'MainThread', `node ${NM}/jest/bin/jest.js`)];
    expect(run(procs, { project: { 710: A, 711: A, 712: A } }).moves).toEqual([]);
  });

  test('D : terminal dans un cycle de ppid : la descente se termine, jamais le terminal ni le shell', () => {
    const procs = [p(600, 601, 'warp', 'warp'), p(601, 600, 'zsh', 'zsh'), p(700, 601, 'MainThread', `node ${NM}/jest/bin/jest.js`)];
    const r = run(procs, { project: { 700: A } });
    expect(r.moves.map(pidsOf)).toEqual([[700]]);
  });

  test('D : ancre absente de la lecture (parent disparu) : rien n’est déplacé', () => {
    const procs = [p(601, 600, 'zsh', 'zsh'), p(700, 601, 'MainThread', `node ${NM}/jest/bin/jest.js`)];
    expect(run(procs, { project: { 700: A } }).moves).toEqual([]);
  });

  test('D : processus zombie (ligne de commande vide, « [nom] ») : ni racine, ni cible', () => {
    const procs = [...warp(), p(700, 601, 'npm run test', 'npm run test'), p(701, 700, 'jest', '[jest]', { rssKB: 0 }),
      p(710, 601, 'node', '[node]', { rssKB: 0 })];
    const r = run(procs, { project: { 700: A, 701: A, 710: A } });
    expect(r.moves.map((m) => [m.rootPid, pidsOf(m)])).toEqual([[700, [700]]]);
  });

  test('D : comm de terminal tronqué à 15 caractères (gnome-terminal-server → gnome-terminal-) : ancre reconnue', () => {
    const procs = [p(600, 500, 'gnome-terminal-', '/usr/libexec/gnome-terminal-server'), p(601, 600, 'bash', 'bash'),
      p(700, 601, 'MainThread', `node ${NM}/jest/bin/jest.js`)];
    const r = run(procs, { project: { 700: A } });
    expect(r.moves.map((m) => [m.rootPid, pidsOf(m)])).toEqual([[700, [700]]]);
  });
});
