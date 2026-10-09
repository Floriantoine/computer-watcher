// src/core/grouping/projectRoot.ts
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// La racine git (dépôt ou worktree) définit le projet : front/ et backend/ avec
// leur propre package.json restent ensemble. Sans .git au-dessus, le package.json
// le plus proche. Le home ne regroupe jamais ses sous-dossiers.
export function findProjectRoot(
  cwd: string,
  exists: (p: string) => boolean = existsSync,
  home: string = homedir(),
): string | null {
  let nearestPkg: string | null = null;
  let dir = cwd;
  for (;;) {
    if (dir === home && dir !== cwd) return nearestPkg;
    if (exists(join(dir, '.git'))) return dir;
    if (nearestPkg === null && exists(join(dir, 'package.json'))) nearestPkg = dir;
    const parent = dirname(dir);
    if (parent === dir) return nearestPkg;
    dir = parent;
  }
}

export function projectLabel(root: string, home: string): string {
  if (root === home) return '~';
  const rel = root.startsWith(home + '/') ? root.slice(home.length + 1) : root;
  const parts = rel.split('/').filter((s) => s && !s.startsWith('.'));
  return parts.slice(-2).join(' / ') || root;
}
