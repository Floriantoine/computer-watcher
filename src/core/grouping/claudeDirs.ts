import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/** Dossiers de config de Claude : $CLAUDE_CONFIG_DIR s'il est défini et absolu, sinon ~/.claude. */
export function claudeDirs(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const dir = env.CLAUDE_CONFIG_DIR;
  return [dir && isAbsolute(dir) ? trimSlash(dir) : join(home, '.claude')];
}

/** path === dir ou path commence par dir + '/' (« ~/.claude-backup » ne compte pas) ; null → false. */
export function isUnderAny(path: string | null, dirs: readonly string[]): boolean {
  if (path === null) return false;
  return dirs.some((d) => path === d || path.startsWith(d.endsWith('/') ? d : `${d}/`));
}
