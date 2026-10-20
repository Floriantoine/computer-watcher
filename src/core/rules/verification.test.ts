// Vérifications lancées par Claude (règle anti-gel) : visables, Claude lui-même et tout le reste toujours protégés.
import { describe, expect, test } from 'vitest';
import { filterTargets, type GuardContext, type GuardProc } from './neverKill';
import { verificationKind, verificationPids } from './verification';

const NM = '/home/u/demo/node_modules';
const p = (pid: number, ppid: number, name: string, cmdline: string, over: Partial<GuardProc> = {}): GuardProc =>
  ({ pid, ppid, name, cmdline, uid: 1000, cwd: '/home/u/demo', ...over });

/** warp → zsh → claude → zsh -c → tsc ; claude → serveur MCP (node) ; claude → zsh -c → vitest → worker → sh. */
function world() {
  const list = [
    p(500, 1, 'systemd', 'systemd --user'),
    p(600, 500, 'warp', 'warp'),
    p(601, 600, 'zsh', 'zsh'),
    p(800, 601, 'claude', 'claude'),
    p(801, 800, 'zsh', '/bin/zsh -c tsc'),
    p(810, 801, 'MainThread', `node ${NM}/typescript/bin/tsc --noEmit`),
    p(820, 800, 'node', 'node /home/u/.local/mcp/server.js'),
    p(830, 800, 'zsh', '/bin/zsh -c vitest'),
    p(831, 830, 'MainThread', `node ${NM}/vitest/vitest.mjs run`),
    p(832, 831, 'MainThread', `node ${NM}/vitest/dist/workers/forks.js`),
    p(840, 800, 'MainThread', `node ${NM}/eslint/bin/eslint.js .`, { cwd: '/home/u/.claude/plugins/x' }),
  ];
  return new Map(list.map((x) => [x.pid, x]));
}

const ctx = (byPid: Map<number, GuardProc>, verification?: Set<number>): GuardContext => ({
  byPid, currentUid: 1000, selfPid: 900, appRoot: null, isProtected: () => false, claudeDirs: ['/home/u/.claude'],
  claudePids: new Set([800, 801, 810, 820, 830, 831, 832, 840]), ...(verification ? { verification } : {}),
});

describe('vérifications lancées par Claude', () => {
  test('verificationKind : tests, tsc, eslint ; jamais Claude, un shell ou un serveur MCP', () => {
    const w = world();
    expect(verificationKind(w.get(810)!)).toBeTruthy();
    expect(verificationKind(w.get(831)!)).toBeTruthy();
    expect(verificationKind(w.get(800)!)).toBeNull();
    expect(verificationKind(w.get(801)!)).toBeNull();
    expect(verificationKind(w.get(820)!)).toBeNull();
    expect(verificationKind({ name: 'claude', cmdline: 'claude --print vitest' })).toBeNull();
  });

  test('verificationPids : racines et descendants, jamais Claude ni ses shells au-dessus', () => {
    const v = verificationPids(world());
    for (const pid of [810, 831, 832]) expect(v.has(pid)).toBe(true);
    for (const pid of [500, 600, 601, 800, 801, 820, 830]) expect(v.has(pid)).toBe(false);
  });

  test('sans le contexte vérification : tout ce qui est sous Claude est refusé (autres règles)', () => {
    const w = world();
    const r = filterTargets([810, 831, 832, 820], ctx(w));
    expect(r.kept).toEqual([]);
    expect([...r.refused.values()].every((why) => why === 'claude')).toBe(true);
  });

  test('avec le contexte vérification : tsc et vitest visables ; Claude, son shell, le MCP et un travail sous ~/.claude jamais', () => {
    const w = world();
    const c = ctx(w, verificationPids(w));
    expect(filterTargets([810], c).kept).toEqual([810]);
    expect(filterTargets([831, 832], c).kept).toEqual([831, 832]);
    const r = filterTargets([800, 801, 820, 840], c);
    expect(r.kept).toEqual([]);
    expect(r.refused.get(800)).toBe('never-kill');
    expect(r.refused.get(801)).toBe('never-kill');
    expect(r.refused.get(820)).toBe('claude');
    expect(r.refused.get(840)).toBe('claude');
  });

  test('une vérification qui lance Claude en dessous : refusée comme lanceur', () => {
    const w = world();
    w.set(850, p(850, 832, 'claude', 'claude'));
    const c = ctx(w, verificationPids(w));
    expect(c.verification!.has(850)).toBe(false);
    expect(filterTargets([831], c).refused.get(831)).toBe('launcher');
  });
});
