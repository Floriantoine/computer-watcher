import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Scripts du package.json : seuls `dev`/`start*` servent, quand leur commande lance l'instance (les dépendances ne classent rien). */
export interface PackageHints { scripts: Record<string, string> }

const TTL_MS = 60_000;
const MAX_CACHE = 500;
const MAX_BYTES = 1024 * 1024;
const cache = new Map<string, { at: number; value: PackageHints | null }>();

const defaultRead = (p: string): string | null => {
  try {
    const st = statSync(p);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    return readFileSync(p, 'utf8');
  } catch { return null; }
};

function parse(text: string | null): PackageHints | null {
  if (text === null) return null;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (!j || typeof j !== 'object') return null;
    const scripts: Record<string, string> = {};
    const s = j.scripts;
    if (s && typeof s === 'object' && !Array.isArray(s)) {
      for (const [k, v] of Object.entries(s)) if (typeof v === 'string') scripts[k] = v;
    }
    return { scripts };
  } catch { return null; }
}

export function readPackageHints(
  projectRoot: string,
  read: (p: string) => string | null = defaultRead,
  now: () => number = Date.now,
): PackageHints | null {
  const t = now();
  const hit = cache.get(projectRoot);
  if (hit && t - hit.at >= 0 && t - hit.at < TTL_MS) return hit.value;
  let text: string | null = null;
  try { text = read(join(projectRoot, 'package.json')); } catch { text = null; }
  const value = parse(text);
  if (!cache.has(projectRoot) && cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
  cache.set(projectRoot, { at: t, value });
  return value;
}

export function clearPackageHintsCache(): void { cache.clear(); }
