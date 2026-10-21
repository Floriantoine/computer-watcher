import { describe, expect, test, vi } from 'vitest';
import { cliArgsFromArgv, reexecAsCli, runArgsFromArgv } from './runEntry';

describe('runArgsFromArgv', () => {
  test('app empaquetée (AppImage) : « run » en tête, après les options Chromium ajoutées par AppRun', () => {
    expect(runArgsFromArgv(['/tmp/.mount_x/computer-watcher', 'run', '--', 'sh', '-c', 'exit 3'], false)).toEqual(['--', 'sh', '-c', 'exit 3']);
    expect(runArgsFromArgv(['/x/computer-watcher', '--no-sandbox', 'run', '--mem', '6G', 'make'], false)).toEqual(['--mem', '6G', 'make']);
    expect(runArgsFromArgv(['/x/computer-watcher', 'run'], false)).toEqual([]);
  });
  test('electron <dossier> (développement) : le chemin de l’app est sauté', () => {
    expect(runArgsFromArgv(['/x/electron', '.', 'run', '--', 'tail'], true)).toEqual(['--', 'tail']);
    expect(runArgsFromArgv(['/x/electron', '--inspect=0', '/w/app', 'run', 'x'], true)).toEqual(['x']);
  });
  test('lancement normal de l’app : null', () => {
    for (const a of [['/x/cw'], ['/x/cw', '--hidden'], ['/x/cw', '--', 'run'], ['/x/cw', 'runx'], ['/x/cw', 'other', 'run'], ['/x/cw', '-run']]) {
      expect(runArgsFromArgv(a, false), a.join(' ')).toBeNull();
    }
    expect(runArgsFromArgv(['/x/electron', 'run'], true)).toBeNull(); // « run » est alors le chemin de l'app
    expect(runArgsFromArgv(['/x/electron', '.'], true)).toBeNull();
  });
});

describe('reexecAsCli', () => {
  test('execve de l’exécutable lui-même en mode Node, sur cli.js à côté de index.js', () => {
    const execve = vi.fn();
    reexecAsCli(['--', 'tail'], { execPath: '/x/cw', dir: '/x/resources/app.asar/out/main', env: { A: '1' }, execve: execve as unknown as (f: string, a: string[], e: NodeJS.ProcessEnv) => never });
    expect(execve).toHaveBeenCalledWith('/x/cw', ['/x/cw', '/x/resources/app.asar/out/main/cli.js', 'run', '--', 'tail'], { A: '1', ELECTRON_RUN_AS_NODE: '1' });
  });
  test('sans execve : message et code 1 (jamais l’app à la place)', () => {
    const exit = vi.fn();
    const write = vi.fn();
    reexecAsCli(['x'], { execPath: '/x/cw', dir: '/d', env: {}, execve: undefined, exit, write });
    expect(write).toHaveBeenCalledWith(expect.stringMatching(/execve/));
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('cliArgsFromArgv (should-wrap, shell-init, claude-hook)', () => {
  test('sous-commandes du CLI reconnues, avec leur nom en tête', () => {
    expect(cliArgsFromArgv(['/x/cw', '--no-sandbox', 'should-wrap', '--shell', 'zsh', '--', 'jest'], false)).toEqual(['should-wrap', '--shell', 'zsh', '--', 'jest']);
    expect(cliArgsFromArgv(['/x/cw', 'shell-init', 'zsh'], false)).toEqual(['shell-init', 'zsh']);
    expect(cliArgsFromArgv(['/x/electron', '.', 'claude-hook'], true)).toEqual(['claude-hook']);
    expect(cliArgsFromArgv(['/x/cw', 'run', '--', 'x'], false)).toEqual(['run', '--', 'x']);
    expect(cliArgsFromArgv(['/x/cw', 'other'], false)).toBeNull();
    expect(cliArgsFromArgv(['/x/cw'], false)).toBeNull();
  });
  test('reexecAsCli : sous-commande transmise', () => {
    const execve = vi.fn();
    reexecAsCli(['zsh'], { execPath: '/x/cw', dir: '/d', env: {}, execve: execve as unknown as (f: string, a: string[], e: NodeJS.ProcessEnv) => never, sub: 'shell-init' });
    expect(execve).toHaveBeenCalledWith('/x/cw', ['/x/cw', '/d/cli.js', 'shell-init', 'zsh'], { ELECTRON_RUN_AS_NODE: '1' });
  });
});
