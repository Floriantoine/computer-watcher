import { describe, expect, test } from 'vitest';
import { HEAVY_NAMES } from '../core/antigel/wrap';
import { antigelFromConfigText, shellInitCli, shouldWrapCli, type WrapCliDeps } from './wrap';

const DEMO = '/home/u/code/demo';
const CONFIG = JSON.stringify({ version: 1, protected: [], othersThreshold: { memMB: 0, cpuPercent: 0 }, antigel: { enabled: true, budgets: { [DEMO]: 6144 } } });

function deps(o: Partial<WrapCliDeps> & { stdin?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const d: WrapCliDeps = {
    env: { SHELL: '/usr/bin/zsh' },
    home: '/home/u',
    cwd: `${DEMO}/src`,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    readConfig: () => CONFIG,
    realpath: (p) => p.replace('/home/u/lien', DEMO),
    findRoot: (cwd) => (cwd === DEMO || cwd.startsWith(`${DEMO}/`) ? DEMO : null),
    readStdin: async () => o.stdin ?? '',
    ...o,
  };
  return { d, out, err };
}

describe('antigelFromConfigText', () => {
  test('config valide : section antigel ; absente, illisible ou refusée : null', () => {
    expect(antigelFromConfigText(CONFIG)?.budgets).toEqual({ [DEMO]: 6144 });
    expect(antigelFromConfigText(null)).toBeNull();
    expect(antigelFromConfigText('{')).toBeNull();
    expect(antigelFromConfigText(JSON.stringify({ version: 2 }))).toBeNull();
    expect(antigelFromConfigText(JSON.stringify({ ...JSON.parse(CONFIG), antigel: { enabled: 'oui' } }))).toBeNull();
  });
});

describe('should-wrap', () => {
  test('lourde dans le budget : ligne réécrite sur stdout, code 0', () => {
    const { d, out } = deps();
    expect(shouldWrapCli(['--shell', 'zsh', '--', 'npm test && jest'], d)).toBe(0);
    expect(out.join('')).toBe("computer-watcher run -- zsh -c 'npm test && jest'\n");
  });
  test('rien à faire : code 1, aucune sortie', () => {
    const { d, out } = deps();
    expect(shouldWrapCli(['--', 'ls'], d)).toBe(1);
    expect(shouldWrapCli(['--', 'jest'], { ...d, cwd: '/ailleurs' })).toBe(1);
    expect(shouldWrapCli(['--', 'jest'], { ...d, readConfig: () => null })).toBe(1);
    expect(shouldWrapCli(['--', 'jest'], { ...d, cwd: null })).toBe(1);
    expect(shouldWrapCli(['--', 'jest'], { ...d, env: { CWATCH_NO_WRAP: '1' } })).toBe(1);
    expect(out).toEqual([]);
  });
  test('--cwd et dossier courant résolus (liens symboliques, comme /proc/<pid>/cwd)', () => {
    const { d, out } = deps({ cwd: '/home/u/lien/src' });
    expect(shouldWrapCli(['--', 'jest'], d)).toBe(0);
    expect(shouldWrapCli(['--cwd', '/home/u/lien', '--', 'vitest'], { ...d, cwd: '/' })).toBe(0);
    expect(out).toEqual(['computer-watcher run -- jest\n', 'computer-watcher run -- vitest\n']);
  });
  test('erreurs d’usage : code 2', () => {
    const { d, err } = deps();
    for (const a of [[], ['jest'], ['--shell', 'fish', '--', 'jest'], ['--shell'], ['--bof', '--', 'x']]) expect(shouldWrapCli(a, d), a.join(' ')).toBe(2);
    expect(err.join('')).toMatch(/should-wrap/);
  });
  test('-h : aide, code 0', () => {
    const { d, out } = deps();
    expect(shouldWrapCli(['-h'], d)).toBe(0);
    expect(out.join('')).toMatch(/Usage : computer-watcher should-wrap/);
  });
  test('exception interne : code 1 (jamais la ligne cassée)', () => {
    const { d } = deps({ findRoot: () => { throw new Error('boum'); } });
    expect(shouldWrapCli(['--', 'jest'], d)).toBe(1);
  });
});

describe('shell-init zsh', () => {
  test('snippet : widget accept-line chaîné, interrupteur, préfiltre, historique original', () => {
    const { d, out } = deps();
    expect(shellInitCli(['zsh'], d)).toBe(0);
    const s = out.join('');
    expect(s).toMatch(/zle -A accept-line _cwatch_wrap_prev_accept_line/);
    expect(s).toMatch(/zle -N accept-line _cwatch_wrap_accept_line/);
    expect(s).toMatch(/CWATCH_NO_WRAP/);
    expect(s).toMatch(/add-zsh-hook zshaddhistory _cwatch_wrap_history/);
    expect(s).toMatch(/should-wrap --shell zsh --/);
    for (const n of HEAVY_NAMES) expect(s).toContain(n);
  });
  test('autre shell ou rien : code 2', () => {
    const { d } = deps();
    expect(shellInitCli([], d)).toBe(2);
    expect(shellInitCli(['bash'], d)).toBe(2);
  });
});

