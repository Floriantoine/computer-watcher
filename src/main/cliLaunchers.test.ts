// Lanceurs de `computer-watcher <sous-commande>` exécutés pour de vrai par /bin/sh, devant un faux exécutable de l'app
// qui affiche ses arguments et son environnement (dossier temporaire sous ~/.cache/pw-*) :
// - build/linux/computer-watcher, l'enveloppe du paquet .deb (/usr/bin/computer-watcher → /opt/…/resources/bin/) ;
// - le lanceur ~/.local/bin/computer-watcher écrit par l'app (launcherScript, AppImage).
// Chromium ne doit jamais voir une option placée avant le « -- » de `run` : mode Node (.deb) ou « -- » inséré (AppImage).
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { LAUNCHER_CLI_SUBCOMMANDS, launcherScript, launcherTargetPath } from '../core/wrapSetup';
import { CLI_SUBCOMMANDS } from './runEntry';

const DEB_WRAPPER = resolve(__dirname, '../../build/linux/computer-watcher');
const root = mkdtempSync(join(homedir(), '.cache', 'pw-cli-launchers-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Faux exécutable : une ligne par argument, puis les variables qui comptent. */
const FAKE = [
  '#!/bin/sh',
  'echo "exe=$0"',
  'for a in "$@"; do echo "arg=$a"; done',
  'echo "ELECTRON_RUN_AS_NODE=${ELECTRON_RUN_AS_NODE-<absent>}"',
  'echo "NODE_OPTIONS=${NODE_OPTIONS-<absent>}"',
  'echo "CWATCH_NODE_OPTIONS=${CWATCH_NODE_OPTIONS-<absent>}"',
  '',
].join('\n');

function writeExe(path: string, text: string): void {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

function call(file: string, args: string[], env: NodeJS.ProcessEnv = {}): string[] {
  const base: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root };
  return execFileSync(file, args, { env: { ...base, ...env }, encoding: 'utf8' }).trimEnd().split('\n');
}

describe('enveloppe du paquet .deb (build/linux/computer-watcher)', () => {
  // arborescence installée : /opt/computer-watcher/{computer-watcher, resources/bin/computer-watcher}, lien /usr/bin
  const opt = join(root, 'opt', 'computer-watcher');
  const usrBin = join(root, 'usr', 'bin');
  mkdirSync(join(opt, 'resources', 'bin'), { recursive: true });
  mkdirSync(usrBin, { recursive: true });
  writeExe(join(opt, 'computer-watcher'), FAKE);
  copyFileSync(DEB_WRAPPER, join(opt, 'resources', 'bin', 'computer-watcher'));
  chmodSync(join(opt, 'resources', 'bin', 'computer-watcher'), 0o755);
  symlinkSync(join(opt, 'resources', 'bin', 'computer-watcher'), join(usrBin, 'computer-watcher'));
  const cmd = join(usrBin, 'computer-watcher');
  const cli = join(opt, 'resources', 'app.asar', 'out', 'main', 'cli.js');

  test('run avec une option avant « -- » : mode Node sur cli.js, Chromium jamais lancé, arguments intacts', () => {
    expect(call(cmd, ['run', '--type=foo', '--', 'rg', '--type=rust', 'a b'])).toEqual([
      `exe=${join(opt, 'computer-watcher')}`, `arg=${cli}`, 'arg=run', 'arg=--type=foo', 'arg=--', 'arg=rg', 'arg=--type=rust', 'arg=a b',
      'ELECTRON_RUN_AS_NODE=1', 'NODE_OPTIONS=<absent>', 'CWATCH_NODE_OPTIONS=<absent>',
    ]);
  });

  test('toutes les sous-commandes du CLI, et « -- » en tête retiré', () => {
    for (const sub of CLI_SUBCOMMANDS) expect(call(cmd, [sub, '--help']).slice(1, 3)).toEqual([`arg=${cli}`, `arg=${sub}`]);
    expect(call(cmd, ['--', 'should-wrap', '--help']).slice(1, 4)).toEqual([`arg=${cli}`, 'arg=should-wrap', 'arg=--help']);
  });

  test('NODE_OPTIONS de l’appelant : retiré pour le CLI, mis de côté pour la commande (même vide)', () => {
    expect(call(cmd, ['run', '--', 'x'], { NODE_OPTIONS: '--max-old-space-size=4096 --require ./a.js' }).slice(-2))
      .toEqual(['NODE_OPTIONS=<absent>', 'CWATCH_NODE_OPTIONS=--max-old-space-size=4096 --require ./a.js']);
    expect(call(cmd, ['run', '--', 'x'], { NODE_OPTIONS: '' }).slice(-2)).toEqual(['NODE_OPTIONS=<absent>', 'CWATCH_NODE_OPTIONS=']);
  });

  test('lancement de l’app (menu, --hidden, --free, autre) : exécutable inchangé, arguments et environnement intacts', () => {
    expect(call(cmd, [])).toEqual([`exe=${join(opt, 'computer-watcher')}`, 'ELECTRON_RUN_AS_NODE=<absent>', 'NODE_OPTIONS=<absent>', 'CWATCH_NODE_OPTIONS=<absent>']);
    expect(call(cmd, ['--hidden'], { NODE_OPTIONS: '--no-warnings' }).slice(1)).toEqual(['arg=--hidden', 'ELECTRON_RUN_AS_NODE=<absent>', 'NODE_OPTIONS=--no-warnings', 'CWATCH_NODE_OPTIONS=<absent>']);
    expect(call(cmd, ['runx']).slice(1, 2)).toEqual(['arg=runx']);
    expect(call(cmd, ['--', 'autre']).slice(1, 3)).toEqual(['arg=--', 'arg=autre']);
  });

  test('chemin introuvable par readlink (copie hors /opt/…/resources/bin) : /opt/computer-watcher par défaut', () => {
    const text = readFileSync(DEB_WRAPPER, 'utf8');
    expect(text).toContain('*) app=/opt/computer-watcher ;;');
    expect(text).toContain(`  ${CLI_SUBCOMMANDS.join('|')})`);
  });
});

describe('lanceur ~/.local/bin/computer-watcher (AppImage)', () => {
  const dir = join(root, 'appimage');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const target = join(dir, "computer-watcher l'app.AppImage");
  writeExe(target, FAKE);
  const launcher = join(dir, 'bin', 'computer-watcher');
  writeExe(launcher, launcherScript({ kind: 'appimage', path: target }));

  test('même liste de sous-commandes que l’entrée de l’app', () => {
    expect([...LAUNCHER_CLI_SUBCOMMANDS]).toEqual([...CLI_SUBCOMMANDS]);
  });

  test('sous-commande du CLI : « -- » inséré devant (Chromium s’arrête là), NODE_OPTIONS mis de côté', () => {
    expect(call(launcher, ['run', '--type=foo', '--', 'rg'], { NODE_OPTIONS: '--max-old-space-size=4096' })).toEqual([
      `exe=${target}`, 'arg=--', 'arg=run', 'arg=--type=foo', 'arg=--', 'arg=rg',
      'ELECTRON_RUN_AS_NODE=<absent>', 'NODE_OPTIONS=<absent>', 'CWATCH_NODE_OPTIONS=--max-old-space-size=4096',
    ]);
  });

  test('autres arguments : AppImage appelée telle quelle', () => {
    expect(call(launcher, ['--free'], { NODE_OPTIONS: '--no-warnings' }).slice(1)).toEqual(['arg=--free', 'ELECTRON_RUN_AS_NODE=<absent>', 'NODE_OPTIONS=--no-warnings', 'CWATCH_NODE_OPTIONS=<absent>']);
  });

  test('cible relue par l’état du réglage (première ligne exec)', () => {
    expect(launcherTargetPath(launcherScript({ kind: 'appimage', path: target }))).toBe(target);
  });

  test('version de développement (mode Node) : NODE_OPTIONS mis de côté aussi', () => {
    const dev = join(dir, 'bin', 'cw-dev');
    writeExe(dev, launcherScript({ kind: 'node', electron: target, cli: '/d/out/main/cli.js' }));
    expect(call(dev, ['run', '--', 'x'], { NODE_OPTIONS: '-r x' })).toEqual([
      `exe=${target}`, 'arg=/d/out/main/cli.js', 'arg=run', 'arg=--', 'arg=x', 'ELECTRON_RUN_AS_NODE=1', 'NODE_OPTIONS=<absent>', 'CWATCH_NODE_OPTIONS=-r x',
    ]);
  });
});
