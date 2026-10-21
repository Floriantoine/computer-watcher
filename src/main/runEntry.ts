// `computer-watcher run …` depuis l'app (AppImage, paquet .deb) : reconnu avant tout effet de bord de l'app, puis
// l'exécutable se remplace lui-même (execve, même PID) par son mode Node sur out/main/cli.js. Aucune fenêtre, aucun
// verrou d'instance, aucun renderer ; Chromium est abandonné (en mode complet, Ctrl+C quitterait l'app avant la commande).
import { join } from 'node:path';

/** Sous-commandes servies par cli.js (Node pur) plutôt que par l'app. */
export const CLI_SUBCOMMANDS: readonly string[] = ['run', 'should-wrap', 'shell-init', 'claude-hook'];

/** Arguments après « run » si l'app est lancée comme `computer-watcher [options Chromium] run …`, sinon null. */
export function runArgsFromArgv(argv: readonly string[], defaultApp: boolean): string[] | null {
  const c = cliArgsFromArgv(argv, defaultApp);
  return c !== null && c[0] === 'run' ? c.slice(1) : null;
}

/**
 * [sous-commande, arguments…] si l'app est lancée comme `computer-watcher [options Chromium] [--] <sous-commande du CLI> …`.
 * Le « -- » facultatif devant la sous-commande arrête l'analyse des options par Chromium : sans lui, une option de la
 * commande placée avant le « -- » de `run` (`run --type=x -- …`) serait lue par Chromium avant notre code (plantage,
 * code 133). Les lanceurs de l'app (paquet .deb, ~/.local/bin/computer-watcher) l'insèrent eux-mêmes.
 */
export function cliArgsFromArgv(argv: readonly string[], defaultApp: boolean): string[] | null {
  let i = 1;
  const skipSwitches = () => {
    while (i < argv.length && argv[i]!.startsWith('--') && argv[i] !== '--') i++;
  };
  skipSwitches();
  if (defaultApp) {
    // electron <chemin de l'app> : le premier argument positionnel est l'app
    if (i >= argv.length) return null;
    i++;
    skipSwitches();
  }
  if (argv[i] === '--') i++;
  return argv[i] !== undefined && CLI_SUBCOMMANDS.includes(argv[i]!) ? argv.slice(i) : null;
}

type Execve = (file: string, args: string[], env: NodeJS.ProcessEnv) => never;

export function reexecAsCli(rest: string[], o: {
  execPath: string; dir: string; env: NodeJS.ProcessEnv; execve: Execve | undefined; exit?: (code: number) => void; write?: (s: string) => void;
  /** Sous-commande (défaut run). */
  sub?: string;
}): void {
  if (typeof o.execve !== 'function') {
    (o.write ?? ((s) => process.stderr.write(s)))('computer-watcher run : process.execve indisponible dans cette version d’Electron\n');
    (o.exit ?? process.exit)(1);
    return;
  }
  o.execve(o.execPath, [o.execPath, join(o.dir, 'cli.js'), o.sub ?? 'run', ...rest], { ...o.env, ELECTRON_RUN_AS_NODE: '1' });
}
