import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/**
 * Dossiers de config de Claude : ~/.claude, plus $CLAUDE_CONFIG_DIR s'il est défini et absolu, chacun avec son
 * chemin réel (le dossier de travail lu dans /proc est résolu : un ~/.claude en lien symbolique ne correspondrait
 * jamais sinon). À calculer une fois au démarrage. Dossier absent ou illisible : chemin gardé tel quel.
 */
export function claudeDirs(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  realpath: (p: string) => string = realpathSync,
): string[] {
  const base = [join(home, '.claude')];
  const extra = env.CLAUDE_CONFIG_DIR;
  if (extra && isAbsolute(extra)) base.push(trimSlash(extra));
  const out: string[] = [];
  for (const d of base) {
    if (!out.includes(d)) out.push(d);
    try {
      const real = trimSlash(realpath(d));
      if (!out.includes(real)) out.push(real);
    } catch {
      /* dossier absent : seul le chemin donné compte */
    }
  }
  return out;
}

/** path === dir ou path commence par dir + '/' (« ~/.claude-backup » ne compte pas) ; null → false. */
export function isUnderAny(path: string | null, dirs: readonly string[]): boolean {
  if (path === null) return false;
  return dirs.some((d) => path === d || path.startsWith(d.endsWith('/') ? d : `${d}/`));
}
