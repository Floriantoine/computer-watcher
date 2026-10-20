// `computer-watcher run …` depuis l'app (AppImage, paquet .deb) : reconnu avant tout effet de bord de l'app, puis
// l'exécutable se remplace lui-même (execve, même PID) par son mode Node sur out/main/cli.js. Aucune fenêtre, aucun
// verrou d'instance, aucun renderer ; Chromium est abandonné (en mode complet, Ctrl+C quitterait l'app avant la commande).
import { join } from 'node:path';

/** Arguments après « run » si l'app est lancée comme `computer-watcher [options Chromium] run …`, sinon null. */
export function runArgsFromArgv(argv: readonly string[], defaultApp: boolean): string[] | null {
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
  return argv[i] === 'run' ? argv.slice(i + 1) : null;
}

type Execve = (file: string, args: string[], env: NodeJS.ProcessEnv) => never;

export function reexecAsCli(rest: string[], o: {
  execPath: string; dir: string; env: NodeJS.ProcessEnv; execve: Execve | undefined; exit?: (code: number) => void; write?: (s: string) => void;
}): void {
  if (typeof o.execve !== 'function') {
    (o.write ?? ((s) => process.stderr.write(s)))('computer-watcher run : process.execve indisponible dans cette version d’Electron\n');
    (o.exit ?? process.exit)(1);
    return;
  }
  o.execve(o.execPath, [o.execPath, join(o.dir, 'cli.js'), 'run', ...rest], { ...o.env, ELECTRON_RUN_AS_NODE: '1' });
}
