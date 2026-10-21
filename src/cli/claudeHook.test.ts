import { describe, expect, test } from 'vitest';
import { claudeHookCli } from './claudeHook';
import type { WrapCliDeps } from './wrap';

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

describe('claude-hook (PreToolUse, outil Bash)', () => {
  const input = (o: Record<string, unknown> = {}, ti: Record<string, unknown> = {}) => JSON.stringify({
    session_id: 's', cwd: `${DEMO}/src`, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'npm test', description: 'Lance les tests', timeout: 120000, ...ti }, ...o,
  });

  test('lourde dans le budget : updatedInput complet (champs conservés), aucune décision d’autorisation', async () => {
    const { d, out } = deps({ stdin: input() });
    expect(await claudeHookCli([], d)).toBe(0);
    const r = JSON.parse(out.join(''));
    expect(r).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { command: 'computer-watcher run -- npm test', description: 'Lance les tests', timeout: 120000 },
      },
    });
    expect(JSON.stringify(r)).not.toMatch(/permissionDecision|allow/);
  });

  test('ligne composée : shell de l’utilisateur (zsh), sinon bash', async () => {
    let { d, out } = deps({ stdin: input({}, { command: 'npm run build && npm test' }) });
    await claudeHookCli([], d);
    expect(JSON.parse(out.join('')).hookSpecificOutput.updatedInput.command).toBe("computer-watcher run -- zsh -c 'npm run build && npm test'");
    ({ d, out } = deps({ stdin: input({}, { command: 'make; jest' }), env: { SHELL: '/usr/bin/fish' } }));
    await claudeHookCli([], d);
    expect(JSON.parse(out.join('')).hookSpecificOutput.updatedInput.command).toBe("computer-watcher run -- bash -c 'make; jest'");
  });

  test('--ask : décision « ask » documentée (montre la commande modifiée), jamais « allow »', async () => {
    const { d, out } = deps({ stdin: input() });
    await claudeHookCli(['--ask'], d);
    const h = JSON.parse(out.join('')).hookSpecificOutput;
    expect(h.permissionDecision).toBe('ask');
    expect(h.permissionDecisionReason).toMatch(/budget/);
  });

  test.each([
    ['autre outil', input({ tool_name: 'Read' })],
    ['autre évènement', input({ hook_event_name: 'PostToolUse' })],
    ['pas lourde', input({}, { command: 'ls' })],
    ['hors budget', input({ cwd: '/ailleurs' })],
    ['cwd absent', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'jest' } })],
    ['command absente', input({}, { command: 3 })],
    ['JSON cassé', '{"tool_name":'],
    ['vide', ''],
    ['tableau', '[]'],
  ])('%s : sortie vide, code 0 (la commande part telle quelle)', async (_n, stdin) => {
    const { d, out } = deps({ stdin });
    expect(await claudeHookCli([], d)).toBe(0);
    expect(out).toEqual([]);
  });

  test('erreur de lecture ou interne : sortie vide, code 0', async () => {
    let r = deps({ readStdin: async () => { throw new Error('EIO'); } });
    expect(await claudeHookCli([], r.d)).toBe(0);
    expect(r.out).toEqual([]);
    r = deps({ stdin: input(), findRoot: () => { throw new Error('boum'); } });
    expect(await claudeHookCli([], r.d)).toBe(0);
    expect(r.out).toEqual([]);
  });
});
