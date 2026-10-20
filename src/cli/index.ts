// Point d'entrée de `computer-watcher run` (out/main/cli.js), en Node pur : ELECTRON_RUN_AS_NODE=1 (relancé ainsi par
// l'app, voir main/runEntry.ts, ou par le lanceur) ou `node`. Aucune fenêtre, aucun renderer, aucune dépendance Electron.
import { USAGE } from '../core/antigel/run';
import { realCliDeps } from './deps';
import { runCli } from './run';

const [sub, ...rest] = process.argv.slice(2);
if (sub !== 'run') {
  process.stderr.write(USAGE);
  process.exitCode = 2;
} else {
  runCli(rest, realCliDeps()).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`computer-watcher run : ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
