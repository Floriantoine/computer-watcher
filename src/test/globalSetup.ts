// Racine temporaire propre à chaque lancement de Vitest, sur disque sous ~/.cache/pw-vitest : /tmp est en RAM, et un
// lancement tué (earlyoom, timeout, Ctrl-C, scope plafonné) y laissait ses fichiers. Le nom de la racine porte son
// propriétaire (voir tmpRoot.ts) : les racines des lancements tués sont purgées au lancement suivant, jamais celle d'un
// Vitest encore vivant (plusieurs worktrees peuvent tester en même temps).
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { purgeOrphanRoots, removeTree, rootPrefix, selfOwner } from './tmpRoot';

export default function setup(): () => void {
  const base = join(homedir(), '.cache', 'pw-vitest');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = realpathSync(mkdtempSync(join(base, rootPrefix(selfOwner()))));
  // Fixé avant le démarrage des workers : ils héritent de TMPDIR, donc os.tmpdir() pointe ici.
  process.env.TMPDIR = root;
  process.env.PROC_WATCH_TEST_TMP = root;
  const p = purgeOrphanRoots(base);
  if (p.purged.length) console.warn(`pw-vitest : ${p.purged.length} racine(s) de lancements interrompus purgée(s)`);
  if (p.errors.length) console.warn(`pw-vitest : purge incomplète (reprise au prochain lancement) :\n  ${p.errors.join('\n  ')}`);
  const cleanup = () => {
    const r = removeTree(root);
    if (!r.removed) console.warn(`pw-vitest : ${root} pas entièrement supprimée (reprise au prochain lancement) :\n  ${r.errors.join('\n  ')}`);
  };
  // Ctrl-C, SIGTERM : Vitest sort par process.exit sans toujours passer par le teardown ; SIGKILL : purge au lancement suivant
  process.once('exit', cleanup);
  return () => {
    process.off('exit', cleanup);
    cleanup();
  };
}
