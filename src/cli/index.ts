// Point d'entrée de `computer-watcher run` (out/main/cli.js), en Node pur : ELECTRON_RUN_AS_NODE=1 (relancé ainsi par
// l'app, voir main/runEntry.ts, ou par le lanceur) ou `node`. Aucune fenêtre, aucun renderer, aucune dépendance Electron.
// Aussi : should-wrap, shell-init et claude-hook (lancer directement dans le budget, voir core/antigel/wrap.ts).
import { USAGE } from '../core/antigel/run';
import { realCliDeps, writeOut } from './deps';
import { runCli } from './run';
import { realWrapDeps, shellInitCli, shouldWrapCli } from './wrap';

const [sub, ...rest] = process.argv.slice(2);
if (sub === 'should-wrap') {
  process.exitCode = shouldWrapCli(rest, realWrapDeps());
} else if (sub === 'shell-init') {
  process.exitCode = shellInitCli(rest, realWrapDeps());
} else if (sub !== 'run') {
  writeOut(2, `${USAGE}\nAutres commandes : computer-watcher should-wrap --help, computer-watcher shell-init zsh\n`);
  process.exitCode = 2;
} else {
  runCli(rest, realCliDeps()).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      writeOut(2, `computer-watcher run : ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
