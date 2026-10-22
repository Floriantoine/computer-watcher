// Mesure et vidage des caches connus de /tmp (liste figée : tmpCaches.ts), partagés par le main (page /tmp, pop-up
// d'alerte) et le service (bouton de la notification tmpfs). Aucune confirmation : rien ne se perd, l'outil reconstruit.
//
// « Vider » supprime les FICHIERS et garde les dossiers : Jest écrit sa carte haste et ses durées dans le dossier du cache
// sans le recréer, et un transform en cours écrit dans un sous-dossier créé juste avant ; garder l'arborescence évite ces
// échecs pendant un test (reste une fenêtre de quelques microsecondes entre un existsSync et une lecture).
//
// Garde-fous : noms figés (jamais de motif) ; dossier à nous, ni lien ni point de montage, aucun montage dessous, même
// système de fichiers que la racine, et non modifiable par d'autres utilisateurs (ses sous-dossiers aussi : sinon jamais
// parcourus). Personne d'autre ne peut donc rien y échanger pendant le parcours. Liens jamais suivis (lstat ; un lien est
// supprimé, sa cible jamais touchée). Durée bornée.
import type { Stats } from 'node:fs';
import * as nodeFsp from 'node:fs/promises';
import { join } from 'node:path';
import { APP_DISPLAY_NAME } from './appName';
import { parseMountinfo } from './mountinfo';
import { TMP_CACHE_IDS, tmpCacheName, type TmpCache, type TmpCacheId, type TmpCacheResult, type TmpCaches, type TmpCachesOutcome } from './tmpCaches';
import { isTrashName, systemEntry } from './tmpClean';

/** Sous-ensemble de fs/promises utilisé (le main et le service passent celui d'`original-fs` : aucune réécriture .asar). */
export interface CachesFs {
  lstat(p: string): Promise<Stats>;
  readdir(p: string): Promise<string[]>;
  unlink(p: string): Promise<void>;
  chmod(p: string, mode: number): Promise<void>;
  realpath(p: string): Promise<string>;
}

export interface TmpCachesOptions {
  /** Utilisateur courant (défaut : process.getuid / getgid) ; uid 0 : tout est refusé. */
  uid?: number;
  gid?: number;
  fs?: CachesFs;
  /** Contenu de /proc/self/mountinfo (défaut : lu) ; illisible : rien n'est vidé. */
  mountinfo?: () => Promise<string>;
  /** Durée maximale (défaut : mesure 3 s, tailles « au moins » au-delà ; vidage 60 s, repris au clic suivant). */
  budgetMs?: number;
  now?: () => number;
}

const MEASURE_BUDGET_MS = 3_000;
const EMPTY_BUDGET_MS = 60_000;
/** lstat / unlink lancés en parallèle. */
const BATCH = 64;
const NO_MOUNTS = 'impossible de vérifier (points de montage illisibles)';

const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? 'erreur';
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

interface Ctx {
  root: string;
  rootDev: number;
  uid: number;
  gid: number;
  /** null : /proc/self/mountinfo illisible. */
  mounts: string[] | null;
  fs: CachesFs;
  now: () => number;
  deadline: number;
}

async function context(root: string, o: TmpCachesOptions, budgetMs: number): Promise<Ctx> {
  const fs = o.fs ?? (nodeFsp as unknown as CachesFs);
  const now = o.now ?? Date.now;
  const real = await fs.realpath(root);
  const st = await fs.lstat(real);
  if (!st.isDirectory()) throw new Error('Racine introuvable');
  let mounts: string[] | null;
  try {
    mounts = parseMountinfo(await (o.mountinfo ?? (() => nodeFsp.readFile('/proc/self/mountinfo', 'utf8')))()).map((m) => m.mount);
  } catch {
    mounts = null;
  }
  return { root: real, rootDev: st.dev, uid: o.uid ?? process.getuid!(), gid: o.gid ?? process.getgid!(), mounts, fs, now, deadline: now() + (o.budgetMs ?? budgetMs) };
}

/** Dossier à nous et non modifiable par d'autres (groupe : seulement notre groupe principal). */
const trusted = (st: Stats, c: Ctx) => st.uid === c.uid && (st.mode & 0o002) === 0 && ((st.mode & 0o020) === 0 || st.gid === c.gid);

/** Cache présent (null : absent) et raison de refus ; un point de montage n'est jamais lstat. */
async function inspect(id: TmpCacheId, c: Ctx): Promise<{ name: string; path: string; mode: number; refusal: string | null } | null> {
  const name = tmpCacheName(id, c.uid);
  const path = join(c.root, name);
  if (c.mounts?.includes(path)) return { name, path, mode: 0, refusal: 'point de montage' };
  let st: Stats;
  try {
    st = await c.fs.lstat(path);
  } catch (e) {
    return code(e) === 'ENOENT' ? null : { name, path, mode: 0, refusal: `illisible (${code(e)})` };
  }
  const refusal =
    // défense en profondeur : jamais un nom de la liste système de /tmp (claude-*, ssh-*…) ni une quarantaine
    systemEntry(name) || isTrashName(name) ? 'système'
    : c.uid === 0 ? `refusé : ${APP_DISPLAY_NAME} tourne en root`
    : c.mounts === null ? NO_MOUNTS
    : st.isSymbolicLink() ? 'lien symbolique (jamais suivi)'
    : !st.isDirectory() ? 'pas un dossier'
    : st.uid !== c.uid ? 'autre utilisateur'
    : st.dev !== c.rootDev ? 'autre système de fichiers'
    : !trusted(st, c) ? 'modifiable par d’autres utilisateurs'
    : c.mounts.some((m) => m.startsWith(`${path}/`)) ? 'contient un point de montage'
    : null;
  return { name, path, mode: st.mode, refusal };
}

/**
 * Parcourt `top` (déjà vérifié) : mesure ou supprime ses fichiers (tout ce qui n'est pas un dossier, liens compris, sans
 * les suivre). Sous-dossiers parcourus seulement s'ils sont à nous, non modifiables par d'autres, sur le même système de
 * fichiers et pas des points de montage ; au vidage, un sous-dossier sans u+rwx (à nous) est d'abord rendu u+rwx.
 */
async function walk(c: Ctx, top: string, empty: boolean) {
  let kb = 0;
  let complete = true;
  let skipped = 0;
  let failed = 0;
  let firstError: string | null = null;
  const mounts = new Set(c.mounts ?? []);
  const stack = [top];
  while (stack.length) {
    const d = stack.pop()!;
    let names: string[];
    try {
      names = await c.fs.readdir(d);
    } catch (e) {
      if (code(e) !== 'ENOENT') skipped++;
      continue;
    }
    for (let i = 0; i < names.length; i += BATCH) {
      if (c.now() > c.deadline) return { kb, complete: false, skipped, failed, firstError };
      const paths = names.slice(i, i + BATCH).map((n) => join(d, n));
      const sts = await Promise.all(paths.map((p) => c.fs.lstat(p).catch(() => null)));
      const files: [string, Stats][] = [];
      for (let j = 0; j < paths.length; j++) {
        const st = sts[j];
        if (!st) continue;
        if (!st.isDirectory()) files.push([paths[j], st]);
        else if (mounts.has(paths[j]) || st.dev !== c.rootDev || !trusted(st, c)) skipped++;
        else {
          if (empty && (st.mode & 0o700) !== 0o700) await c.fs.chmod(paths[j], (st.mode & 0o7777) | 0o700).catch(() => {});
          stack.push(paths[j]);
        }
      }
      if (!empty) for (const [, st] of files) kb += st.blocks / 2;
      else
        await Promise.all(
          files.map(([p, st]) =>
            c.fs.unlink(p).then(
              () => void (kb += st.blocks / 2),
              (e) => {
                if (code(e) === 'ENOENT') return; // déjà supprimé (l'outil lui-même) : c'est le résultat voulu
                failed++;
                firstError ??= code(e);
              },
            ),
          ),
        );
    }
    if (c.now() > c.deadline && stack.length) complete = false;
    if (!complete) break;
  }
  return { kb, complete, skipped, failed, firstError };
}

/** Caches connus présents dans `root` (vrai /tmp ou racine de test), avec leur taille et leur refus éventuel. */
export async function measureTmpCaches(root: string, o: TmpCachesOptions = {}): Promise<TmpCaches> {
  const c = await context(root, o, MEASURE_BUDGET_MS);
  const caches: TmpCache[] = [];
  for (const id of TMP_CACHE_IDS) {
    const r = await inspect(id, c);
    if (!r) continue;
    if (r.refusal !== null) {
      caches.push({ id, name: r.name, sizeKB: 0, atLeast: false, refusal: r.refusal });
      continue;
    }
    const w = await walk(c, r.path, false);
    caches.push({ id, name: r.name, sizeKB: Math.round(w.kb), atLeast: !w.complete || w.skipped > 0, refusal: null });
  }
  return { root, caches };
}

/** Vide les caches demandés (identifiants vérifiés par l'appelant) ; un cache absent n'a pas de résultat. */
export async function emptyTmpCaches(root: string, ids: readonly TmpCacheId[], o: TmpCachesOptions = {}): Promise<TmpCachesOutcome> {
  const c = await context(root, o, EMPTY_BUDGET_MS);
  const results: TmpCacheResult[] = [];
  for (const id of TMP_CACHE_IDS.filter((x) => ids.includes(x))) {
    const r = await inspect(id, c);
    if (!r) continue;
    if (r.refusal !== null) {
      results.push({ id, name: r.name, ok: false, freedKB: 0, reason: r.refusal });
      continue;
    }
    // à nous (vérifié) : rendu u+rwx comme ses sous-dossiers, sinon ses fichiers ne se suppriment pas
    if ((r.mode & 0o700) !== 0o700) await c.fs.chmod(r.path, (r.mode & 0o7777) | 0o700).catch(() => {});
    const w = await walk(c, r.path, true);
    const freedKB = Math.round(w.kb);
    const why = [
      ...(w.complete ? [] : ['temps écoulé']),
      ...(w.failed ? [`${plural(w.failed, 'fichier non supprimé', 'fichiers non supprimés')} (${w.firstError})`] : []),
      ...(w.skipped ? [`${plural(w.skipped, 'dossier ignoré', 'dossiers ignorés')} (autre propriétaire, droits ou point de montage)`] : []),
    ];
    if (!why.length) results.push({ id, name: r.name, ok: true, freedKB });
    else results.push({ id, name: r.name, ok: false, freedKB, ...(freedKB > 0 ? { partial: true } : {}), reason: why.join(' ; ') });
  }
  return { results, freedKB: results.reduce((s, x) => s + x.freedKB, 0) };
}
