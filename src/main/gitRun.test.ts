import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { createGitRun, gitEnv, riskyGitConfig } from './gitRun';

mkdirSync(join(homedir(), '.cache'), { recursive: true });
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const GIT = existsSync('/usr/bin/git') ? '/usr/bin/git' : '/bin/git';

describe('gitEnv', () => {
  test('aucune variable GIT_* héritée ; invite, verrous optionnels et locale fixés', () => {
    expect(gitEnv({ PATH: '/usr/bin', HOME: '/h', GIT_DIR: '/x', GIT_WORK_TREE: '/y', GIT_CONFIG_PARAMETERS: "'core.fsmonitor=x'", GIT_SSH_COMMAND: 'x' }))
      .toEqual({ PATH: '/usr/bin', HOME: '/h', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' });
  });
});

describe('createGitRun', () => {
  test('git absent : null', () => {
    expect(createGitRun({ exists: () => false })).toBeNull();
  });
  test('code de sortie, sortie standard ; jamais de shell', async () => {
    const base = realpathSync(mkdtempSync(join(homedir(), '.cache', 'pw-disk2-gitrun-')));
    made.push(base);
    const git = createGitRun({ env: { PATH: '/usr/bin:/bin', HOME: base } })!;
    const v = await git(['--version'], { cwd: base });
    expect(v.code).toBe(0);
    expect(v.stdout).toMatch(/^git version/);
    expect((await git(['rev-parse', '--git-dir'], { cwd: base })).code).not.toBe(0); // pas un dépôt
    expect((await git(['--version; touch pwned'], { cwd: base })).code).not.toBe(0); // un seul argument, pas de shell
    expect(existsSync(join(base, 'pwned'))).toBe(false);
  });
  test('core.fsmonitor d’un dépôt jamais exécuté', async () => {
    const base = realpathSync(mkdtempSync(join(homedir(), '.cache', 'pw-disk2-gitrun-')));
    made.push(base);
    const env = { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    execFileSync(GIT, ['init', '-q'], { cwd: base, env });
    writeFileSync(join(base, 'a.txt'), 'a');
    execFileSync(GIT, ['config', 'core.fsmonitor', `touch ${join(base, 'marqueur')}`], { cwd: base, env });
    const git = createGitRun({ env: { PATH: '/usr/bin:/bin', HOME: base } })!;
    expect((await git(['status', '--porcelain=v1', '-z'], { cwd: base })).code).toBe(0);
    expect(existsSync(join(base, 'marqueur'))).toBe(false);
  });
});

describe('riskyGitConfig', () => {
  test('filtre ou hooks dans la config du dépôt (include compris) : refusé ; config globale et -c : ignorées ; jamais exécuté', async () => {
    const base = realpathSync(mkdtempSync(join(homedir(), '.cache', 'pw-disk2-gitrun-')));
    made.push(base);
    const globalCfg = join(base, 'global.gitconfig');
    writeFileSync(globalCfg, '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n');
    const env = { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalCfg };
    execFileSync(GIT, ['init', '-q'], { cwd: base, env });
    const git = createGitRun({ env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalCfg } })!;
    expect(await riskyGitConfig(git, base)).toBeNull(); // global (git-lfs) et nos -c seulement
    writeFileSync(join(base, 'inclus.gitconfig'), `[filter "x"]\n\tsmudge = touch ${join(base, 'marqueur')}\n`);
    execFileSync(GIT, ['config', 'include.path', join(base, 'inclus.gitconfig')], { cwd: base, env });
    expect(await riskyGitConfig(git, base)).toBe('filtre git configuré : vérifie à la main');
    execFileSync(GIT, ['config', '--unset', 'include.path'], { cwd: base, env });
    execFileSync(GIT, ['config', 'core.hooksPath', '.husky'], { cwd: base, env });
    expect(await riskyGitConfig(git, base)).toBe('filtre git configuré : vérifie à la main');
    expect(existsSync(join(base, 'marqueur'))).toBe(false);
  });
});
