// Place occupée par /tmp (tmpfs : en RAM), par dossier de premier niveau. Lecture seule : rien n'est jamais supprimé.
import { lstat, opendir } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import type { TmpDirUsage, TmpUsage } from '../core/types';

export interface TmpScanOptions {
  /** Entrées examinées au plus (au-delà : arrêt, tailles « au moins »). */
  maxEntries?: number;
  /** Durée maximale du parcours (ms). */
  budgetMs?: number;
  /** Nombre de dossiers renvoyés. */
  limit?: number;
  now?: () => number;
}

/** Place réellement occupée (blocs alloués), en Ko. */
const usedKB = (st: Stats) => (st.blocks * 512) / 1024;

/**
 * Plus gros dossiers de premier niveau de `root` (équivalent de `du -x` sans suivre les liens), asynchrone : le main
 * n'est jamais bloqué. Liens symboliques jamais suivis ; autres systèmes de fichiers (montages FUSE des AppImage
 * `/tmp/.mount_*`) ignorés ; dossiers illisibles ignorés et comptés ; arrêt à `maxEntries` entrées ou `budgetMs`.
 */
export async function topTmpDirs(root = '/tmp', o: TmpScanOptions = {}): Promise<TmpUsage> {
  const maxEntries = o.maxEntries ?? 20_000;
  const budgetMs = o.budgetMs ?? 2_000;
  const limit = o.limit ?? 5;
  const now = o.now ?? Date.now;
  const start = now();
  let entries = 0;
  let skipped = 0;
  let truncated = false;
  /** Compte une entrée ; vrai quand le plafond ou le budget est atteint (le parcours s'arrête). */
  const stop = (): boolean => {
    if (truncated) return true;
    if (entries >= maxEntries || now() - start >= budgetMs) truncated = true;
    else entries++;
    return truncated;
  };

  let rootSt: Stats;
  try {
    rootSt = await lstat(root);
    if (!rootSt.isDirectory()) throw new Error('ENOTDIR');
  } catch {
    return { dirs: [], rootFilesKB: 0, skipped: 1, truncated: false };
  }
  const dev = rootSt.dev;

  /** Lit un dossier : sous-dossiers à parcourir dans `pending`, taille des entrées ; false s'il est illisible. */
  const readDir = async (d: string, acc: { size: number; pending: string[] }): Promise<boolean> => {
    let handle;
    try {
      handle = await opendir(d);
    } catch {
      skipped++;
      return false;
    }
    for await (const ent of handle) {
      if (stop()) break; // quitter la boucle ferme le dossier
      const p = join(d, ent.name);
      let s: Stats;
      try {
        s = await lstat(p);
      } catch {
        continue; // disparu entre-temps
      }
      if (s.isDirectory()) {
        if (s.dev !== dev) continue; // autre système de fichiers : jamais compté
        acc.pending.push(p);
      }
      acc.size += usedKB(s); // fichier, dossier, ou lien symbolique (le lien lui-même, jamais sa cible)
    }
    return true;
  };

  // 1) premier niveau d'abord : fichiers racine complets et liste des dossiers, avant de descendre
  const tops: { path: string; size: number; pending: string[]; readable: boolean }[] = [];
  let rootFilesKB = 0;
  let top;
  try {
    top = await opendir(root);
  } catch {
    return { dirs: [], rootFilesKB: 0, skipped: 1, truncated: false };
  }
  for await (const ent of top) {
    if (stop()) break;
    const p = join(root, ent.name);
    let st: Stats;
    try {
      st = await lstat(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) rootFilesKB += usedKB(st);
    else if (st.dev === dev) tops.push({ path: p, size: usedKB(st), pending: [p], readable: true }); // sinon : montage, ignoré
  }
  // 2) descente à tour de rôle (un dossier lu par dossier de premier niveau et par tour) : à l'arrêt, chacun a eu sa part
  for (let active = tops; active.length && !truncated; active = active.filter((t) => t.readable && t.pending.length)) {
    for (const t of active) {
      if (truncated) break;
      const d = t.pending.pop()!;
      const ok = await readDir(d, t);
      if (!ok && d === t.path) t.readable = false; // dossier de premier niveau illisible : ignoré
    }
  }
  const dirs: TmpDirUsage[] = tops.filter((t) => t.readable).map((t) => ({ path: t.path, sizeKB: Math.round(t.size) }));
  dirs.sort((a, b) => b.sizeKB - a.sizeKB);
  return { dirs: dirs.slice(0, limit), rootFilesKB: Math.round(rootFilesKB), skipped, truncated };
}

/** Réutilise le parcours en cours (pas deux parcours simultanés) ; un appel après sa fin en relance un. */
export function sharedScan(scan: () => Promise<TmpUsage> = () => topTmpDirs()): () => Promise<TmpUsage> {
  let running: Promise<TmpUsage> | null = null;
  return () => {
    running ??= scan().finally(() => {
      running = null;
    });
    return running;
  };
}
