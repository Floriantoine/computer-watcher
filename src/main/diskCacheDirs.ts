// Page Disque, lot 2 : explorateur des dossiers inconnus de ~/.cache. Racine XDG vérifiée comme pour les familles ;
// dossiers réels seulement (jamais un lien), même disque que le dossier personnel, aucun montage dessous, personne dedans.
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isExplorableName, knownCacheNames } from '../core/disk/cacheExplorer';
import type { CacheDirCandidate } from '../core/disk/extras';
import { familyRootRefusal, usedByText, type FamilyRoots } from '../core/disk/families';
import type { DuFn } from '../core/disk/measure';
import { lsReal, realOr, withNoAsar, type Holder } from './diskClean';
import { mountPointsOf, removeTreeSafe } from './safeFs';

export const MAX_CACHE_DIRS = 50;
const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);
/** Même contrôle de racine que les familles de ~/.cache (uv sert de représentant : racine XDG_CACHE_HOME). */
const rootRefusal = (r: FamilyRoots) => familyRootRefusal('uv', r, { real: realOr, ls: lsReal });

export async function listCacheDirs(r: FamilyRoots, d: { du: DuFn; mountinfo(): string }): Promise<{ dirs: CacheDirCandidate[]; refusal: string | null }> {
  const refusal = rootRefusal(r);
  if (refusal) return { dirs: [], refusal };
  const known = knownCacheNames(r);
  let names: string[];
  try {
    names = readdirSync(r.cacheHome);
  } catch {
    return { dirs: [], refusal: null };
  }
  let homeDev: number;
  try {
    homeDev = lstatSync(r.home).dev;
  } catch {
    return { dirs: [], refusal: 'dossier personnel illisible' };
  }
  let mounts: string[];
  try {
    mounts = mountPointsOf(d.mountinfo());
  } catch {
    mounts = [];
  }
  const realRoot = realOr(r.cacheHome);
  const dirs: CacheDirCandidate[] = [];
  for (const name of names.sort()) {
    if (!isExplorableName(name, known)) continue;
    const path = join(r.cacheHome, name);
    try {
      const st = lstatSync(path);
      if (!st.isDirectory()) continue; // lstat : un lien n'est jamais un dossier
      const real = join(realRoot, name);
      const why = st.dev !== homeDev ? 'sur un autre disque que le dossier personnel' : mounts.some((m) => under(m, real)) ? 'point de montage dessous' : null;
      dirs.push({ name, path, sizeKB: null, refusal: why });
    } catch {
      // disparu
    }
  }
  const sizes = dirs.length ? await d.du(dirs.map((x) => x.path)) : new Map<string, number>();
  for (const x of dirs) x.sizeKB = sizes.get(x.path) ?? null;
  return { dirs: dirs.sort((a, b) => (b.sizeKB ?? -1) - (a.sizeKB ?? -1)).slice(0, MAX_CACHE_DIRS), refusal: null };
}

/** Revérification d'un dossier inconnu (avant la confirmation, puis juste avant de supprimer). */
export function checkCacheDir(r: FamilyRoots, name: string, d: { mountinfo(): string; dirUser(dir: string): Holder | null }): string | null {
  if (!isExplorableName(name, knownCacheNames(r))) return 'nom refusé';
  const root = rootRefusal(r);
  if (root) return root;
  const path = join(r.cacheHome, name);
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 'introuvable';
  }
  if (st.isSymbolicLink()) return `${path} : lien symbolique, refusé (jamais suivi)`;
  if (!st.isDirectory()) return 'pas un dossier';
  let real: string;
  try {
    if (st.dev !== lstatSync(r.home).dev) return 'sur un autre disque que le dossier personnel';
    real = join(realpathSync(r.cacheHome), name);
    if (realpathSync(path) !== real) return 'lien symbolique dans le chemin, refusé';
  } catch (e) {
    return `vérification impossible (${(e as Error).message})`;
  }
  try {
    if (mountPointsOf(d.mountinfo()).some((m) => under(m, real))) return 'point de montage dessous';
  } catch {
    return 'points de montage illisibles';
  }
  const user = d.dirUser(path);
  return user ? usedByText(user) : null;
}

/** Suppression par descripteurs sous XDG_CACHE_HOME (lien en tête refusé), archives .asar désactivées. */
export function removeCacheDir(r: FamilyRoots, name: string, d: { mountinfo(): string; remove?: typeof removeTreeSafe }): void {
  if (!isExplorableName(name, knownCacheNames(r))) throw new Error('nom refusé');
  withNoAsar(() => (d.remove ?? removeTreeSafe)([r.cacheHome], join(r.cacheHome, name), { mountinfo: d.mountinfo() }));
}
