import { describe, expect, test } from 'vitest';
import type { ProcInfo } from '../types';
import { MIN_ROOT_AGE_SEC, planMoves, type PlanMove } from './plan';

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

  test('A : shell enfant direct de Claude hors outil Bash (MCP local « bash -c node …/dist/index.js ») : jamais déplacé', () => {
    const procs = [...warp(), p(800, 601, 'claude', 'claude'),
      p(850, 800, 'bash', 'bash -c node /home/u/alpha/mcp/dist/index.js', { cwd: A }),
      p(851, 850, 'MainThread', 'node /home/u/alpha/mcp/dist/index.js', { cwd: A })];
    expect(run(procs, { project: { 850: A, 851: A } }).moves).toEqual([]);
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

describe('course au lancement et intouchables (relecture, correction 1)', () => {
  test('a : racine trop jeune (lanceur seul, sans enfant encore visible) : pas déplacée à ce tick, refus « young »', () => {
    const procs = [...warp(), p(700, 601, 'npm run test', 'npm run test', { ageSec: 0.4 }),
      p(710, 601, 'MainThread', `node ${NM}/vite/bin/vite.js --open`, { ageSec: MIN_ROOT_AGE_SEC - 0.01 })];
    const r = run(procs, { project: { 700: A, 710: A } });
    expect(r.moves).toEqual([]);
    expect(r.refused).toContainEqual({ pid: 700, reason: 'young' });
    expect(r.refused).toContainEqual({ pid: 710, reason: 'young' });
  });

  test('a : à partir de MIN_ROOT_AGE_SEC, la racine est déplacée', () => {
    const r = run([...warp(), p(700, 601, 'npm run test', 'npm run test', { ageSec: MIN_ROOT_AGE_SEC })], { project: { 700: A } });
    expect(r.moves.map(pidsOf)).toEqual([[700]]);
  });

  test('capturé tôt : âge minimal d’une seconde (la mémoire allouée avant le déplacement reste comptée ailleurs)', () => {
    expect(MIN_ROOT_AGE_SEC).toBe(1);
    // jest et ses workers vus 1,2 s après le lancement : déplacés dès ce tick
    const procs = [...warp(), p(700, 601, 'MainThread', `node ${NM}/jest/bin/jest.js`, { ageSec: 1.2 }),
      p(701, 700, 'MainThread', `node ${NM}/jest-worker/build/workers/processChild.js`, { ageSec: 0.3 })];
    const r = run(procs, { project: { 700: A, 701: A } });
    expect(r.moves.map((m) => [m.rootPid, pidsOf(m)])).toEqual([[700, [700, 701]]]);
  });

  test('b : lanceur d’une session Claude seul (npm exec, npx, pnpm dlx, bunx), même ancien : jamais déplacé', () => {
    const procs = [...warp(),
      p(700, 601, 'npm exec @anth', 'npm exec @anthropic-ai/claude-code', { ageSec: 60 }),
      p(701, 601, 'npx', 'npx claude --resume', { ageSec: 60 }),
      p(702, 601, 'pnpm', 'pnpm dlx @anthropic-ai/claude-code@2.1.0', { ageSec: 60 }),
      p(703, 601, 'bunx', 'bunx claude', { ageSec: 60 })];
    const r = run(procs, { project: { 700: A, 701: A, 702: A, 703: A } });
    expect(r.moves).toEqual([]);
    for (const pid of [700, 701, 702, 703]) expect(r.refused).toContainEqual({ pid, reason: 'blocked' });
  });

  test('c : processus dont le dossier de travail est dans l’app (n’importe quel worktree), seul : jamais déplacé', () => {
    const procs = [...warp(),
      p(700, 601, 'npm run dev', 'npm run dev', { ageSec: 60, cwd: '/home/u/dev/proc-watch/.worktrees/demo' }),
      p(701, 601, 'npm run dev', 'npm run dev', { ageSec: 60, cwd: '/home/u/computer-watcher' })];
    expect(run(procs, { project: { 700: '/home/u/dev/proc-watch', 701: '/home/u/computer-watcher' } }).moves).toEqual([]);
  });

  test('c : un lanceur au-dessus d’un processus travaillant dans l’app est bloqué', () => {
    const procs = [...warp(), p(700, 601, 'MainThread', `node ${NM}/concurrently/index.js`, { cwd: A }),
      p(701, 700, 'npm run dev', 'npm run dev', { cwd: '/home/u/computer-watcher' })];
    const r = run(procs, { project: { 700: A, 701: '/home/u/computer-watcher' } });
    expect(r.moves).toEqual([]);
    expect(r.refused).toContainEqual({ pid: 700, reason: 'blocked' });
  });

  test('IntelliJ lancé par java : ancre jamais déplacée, ce qu’il lance (jest) est déplacé', () => {
    const IDEA = `${BASE}/app.slice/app-idea-7.scope`;
    const procs = [p(450, 1, 'java', '/usr/lib/jvm/java-17/bin/java -Xmx2g -cp /opt/idea/lib/app.jar com.intellij.idea.Main'),
      p(451, 450, 'MainThread', `node ${NM}/jest/bin/jest.js`)];
    const r = run(procs, { project: { 450: A, 451: A }, cg: { 450: IDEA, 451: IDEA } });
    expect(r.moves.map((m) => [m.rootPid, m.anchorCgroup, pidsOf(m)])).toEqual([[451, IDEA, [451]]]);
  });

  test('éditeurs ouverts sur un fichier .js depuis le terminal (kate, zed, VS Code principal) : jamais déplacés', () => {
    for (const [name, cmdline] of [['kate', 'kate x.js'], ['zed', 'zed x.js'], ['code', 'code dist/server.js'], ['code', '/usr/share/code/code dist/server.js'], ['code', '/usr/share/code/code server.js']]) {
      const procs = [...warp(), p(700, 601, name!, cmdline!, { ageSec: 60, cwd: A })];
      const r = run(procs, { project: { 700: A } });
      expect(r.moves, cmdline).toEqual([]);
    }
  });

  test('VS Code : script d’une extension lancé par l’hôte d’extensions (enfant de l’éditeur) : déplacé, jamais l’éditeur', () => {
    const procs = [p(400, 1, 'code', '/usr/share/code/code'),
      p(402, 400, 'code', '/usr/share/code/code --type=utility --utility-sub-type=node.mojom.NodeService'),
      p(403, 402, 'code', '/usr/share/code/code /home/u/.local/share/demo-ext/node_modules/typescript/lib/tsserver.js --node-ipc')];
    const r = run(procs, { cg: { 400: CODE, 402: CODE, 403: CODE } });
    expect(r.moves.map((m) => [m.rootPid, m.anchorCgroup, pidsOf(m)])).toEqual([[403, CODE, [403]]]);
  });

  test('VS Code : tsserver lancé par code (comm « code », ELECTRON_RUN_AS_NODE) : déplacé, jamais code', () => {
    const procs = [p(400, 1, 'code', '/usr/share/code/code'),
      p(401, 400, 'code', '/usr/share/code/code /usr/share/code/resources/app/extensions/node_modules/typescript/lib/tsserver.js --serverMode partialSemantic')];
    const r = run(procs, { cg: { 400: CODE, 401: CODE } });
    expect(r.moves.map((m) => [m.rootPid, m.anchorCgroup, pidsOf(m)])).toEqual([[401, CODE, [401]]]);
  });
});
