// src/core/grouping/projectRoot.ts
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function findProjectRoot(cwd: string, exists: (p: string) => boolean = existsSync): string | null {
  let dir = cwd;
  for (;;) {
    if (exists(join(dir, '.git')) || exists(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function projectLabel(root: string, home: string): string {
  if (root === home) return '~';
  const rel = root.startsWith(home + '/') ? root.slice(home.length + 1) : root;
  const parts = rel.split('/').filter((s) => s && !s.startsWith('.'));
  return parts.slice(-2).join(' / ') || root;
}
