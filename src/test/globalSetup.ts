// Racine temporaire propre à chaque lancement de Vitest : /tmp est en RAM (tmpfs), rien ne doit y rester.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), 'pw-vitest-'));
  // Fixé avant le démarrage des workers : ils héritent de TMPDIR, donc os.tmpdir() pointe ici.
  process.env.TMPDIR = root;
  process.env.PROC_WATCH_TEST_TMP = root;
  return () => rmSync(root, { recursive: true, force: true });
}
