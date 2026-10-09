import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { APP_NAME, LEGACY_APP_NAME } from './appName';

export const newDir = (base: string) => join(base, APP_NAME);
export const legacyDir = (base: string) => join(base, LEGACY_APP_NAME);

/**
 * Dossier de l'app sous `base` : le nouveau s'il existe, sinon l'ancien s'il existe (migration pas encore faite ou
 * échouée), sinon le nouveau.
 */
export function appDir(base: string, exists: (p: string) => boolean = existsSync): string {
  const n = newDir(base);
  if (exists(n)) return n;
  const l = legacyDir(base);
  return exists(l) ? l : n;
}
