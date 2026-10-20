import { describe, expect, test, vi } from 'vitest';
import { reexecAsCli, runArgsFromArgv } from './runEntry';

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
