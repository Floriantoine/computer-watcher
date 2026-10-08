import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PackageHints { front: boolean; back: boolean; scripts: Record<string, string> }

const FRONT_DEPS = ['react', 'vue', 'svelte', '@angular/core', 'solid-js'];
const BACK_DEPS = ['express', 'fastify', '@nestjs/core', 'koa', '@hapi/hapi'];
const TTL_MS = 60_000;
const MAX_CACHE = 500;
const cache = new Map<string, { at: number; value: PackageHints | null }>();

const defaultRead = (p: string): string | null => {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
};

function parse(text: string | null): PackageHints | null {
  if (text === null) return null;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (!j || typeof j !== 'object') return null;
    const deps = new Set<string>();
    for (const k of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const d = j[k];
      if (d && typeof d === 'object') for (const n of Object.keys(d)) deps.add(n);
    }
    const back = BACK_DEPS.some((d) => deps.has(d));
    const front = !back && FRONT_DEPS.some((d) => deps.has(d));
    const scripts: Record<string, string> = {};
    const s = j.scripts;
    if (s && typeof s === 'object') {
      for (const [k, v] of Object.entries(s)) if (typeof v === 'string') scripts[k] = v;
    }
    return { front, back, scripts };
  } catch { return null; }
}

export function readPackageHints(
  projectRoot: string,
  read: (p: string) => string | null = defaultRead,
  now: () => number = Date.now,
): PackageHints | null {
  const t = now();
  const hit = cache.get(projectRoot);
  if (hit && t - hit.at < TTL_MS) return hit.value;
  const value = parse(read(join(projectRoot, 'package.json')));
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
  cache.set(projectRoot, { at: t, value });
  return value;
}

export function clearPackageHintsCache(): void { cache.clear(); }
