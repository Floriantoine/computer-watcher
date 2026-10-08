// Place occupée par /tmp (tmpfs : en RAM), par dossier de premier niveau. Lecture seule : rien n'est jamais supprimé.
import { lstat, opendir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TMP_SCAN_LIMITS } from '../core/tmpScanLimits';
import type { TmpDirUsage, TmpUsage } from '../core/types';

/** Accès au système de fichiers utilisés par le parcours (injectable pour les tests : appels qui ne rendent jamais la main). */
export interface ScanFs {
  opendir(path: string): Promise<AsyncIterable<{ name: string; isDirectory(): boolean }>>;
  lstat(path: string): Promise<{ isDirectory(): boolean; dev: number; blocks: number }>;
}
const nodeFs: ScanFs = { opendir: (p) => opendir(p), lstat: (p) => lstat(p) };

export interface TmpScanOptions {
  /** Entrées examinées au plus (au-delà : arrêt, tailles « au moins »). */
  maxEntries?: number;
  /** Durée du parcours (ms) ; vérifiée entre deux lectures. */
  budgetMs?: number;
  /** Délai dur (ms, défaut budgetMs + 1 s) : le résultat partiel est rendu même si un appel au système de fichiers reste bloqué. */
  hardTimeoutMs?: number;
  /** Nombre de dossiers renvoyés. */
  limit?: number;
  now?: () => number;
  fs?: ScanFs;
  /** Points de montage (défaut : /proc/self/mountinfo). */
  mountPoints?: () => Promise<Iterable<string>>;
}

/** lstat lancés en parallèle (finir plus souvent dans le budget). */
const BATCH = 64;

/** Place réellement occupée (blocs alloués), en Ko. */
const usedKB = (st: { blocks: number }) => (st.blocks * 512) / 1024;

const unescapeMount = (s: string) => s.replace(/\\(\d{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));

/**
 * Points de montage strictement sous `root`, lus dans /proc/self/mountinfo (5e champ). procfs ne bloque pas, contrairement
 * à un lstat sur un montage FUSE (AppImage `/tmp/.mount_*`, sshfs) dont le démon est figé. Erreur de lecture : aucun.
 */
export async function mountPointsUnder(
  root: string,
  read: () => Promise<string> = () => readFile('/proc/self/mountinfo', 'utf8'),
): Promise<Set<string>> {
  let text: string;
  try {
    text = await read();
  } catch {
    return new Set();
  }
  const prefix = root.endsWith('/') ? root : `${root}/`;
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    const m = line.split(' ')[4];
    if (m === undefined) continue;
    const p = unescapeMount(m);
    if (p.startsWith(prefix)) out.add(p);
  }
  return out;
}

/**
 * Plus gros dossiers de premier niveau de `root` (équivalent de `du -x` sans suivre les liens), asynchrone : le main
 * n'est jamais bloqué. Points de montage sous `root` écartés par leur chemin avant tout appel (et `st.dev` en second
 * garde-fou) ; liens symboliques jamais suivis ; dossiers illisibles ignorés et comptés ; erreur en cours de lecture :
 * liste partielle. Arrêt à `maxEntries` entrées ou `budgetMs` ; quoi qu'il arrive, la promesse se règle au plus tard
 * après `hardTimeoutMs` avec le résultat partiel (`truncated`).
 */
export function topTmpDirs(root = '/tmp', o: TmpScanOptions = {}): Promise<TmpUsage> {
  const maxEntries = o.maxEntries ?? TMP_SCAN_LIMITS.maxEntries;
  const budgetMs = o.budgetMs ?? TMP_SCAN_LIMITS.budgetMs;
  const hardTimeoutMs = o.hardTimeoutMs ?? budgetMs + 1_000;
  const limit = o.limit ?? 5;
  const now = o.now ?? Date.now;
  const fs = o.fs ?? nodeFs;
  const start = now();
  let entries = 0;
  let skipped = 0;
  let truncated = false;
  let rootFilesKB = 0;
  let missing = false;
  const tops: { path: string; size: number; pending: string[]; readable: boolean }[] = [];

  const overTime = (): boolean => {
    if (!truncated && now() - start >= budgetMs) truncated = true;
    return truncated;
  };
  /** Compte une entrée ; vrai quand le plafond ou le budget est atteint (le parcours s'arrête). */
  const stop = (): boolean => {
    if (overTime()) return true;
    if (entries >= maxEntries) truncated = true;
    else entries++;
    return truncated;
  };

  const result = (): TmpUsage => {
    if (missing) return { dirs: [], rootFilesKB: 0, skipped: 1, truncated: false };
    const dirs: TmpDirUsage[] = tops.filter((t) => t.readable).map((t) => ({ path: t.path, sizeKB: Math.round(t.size) }));
    dirs.sort((a, b) => b.sizeKB - a.sizeKB);
    return { dirs: dirs.slice(0, limit), rootFilesKB: Math.round(rootFilesKB), skipped, truncated };
  };

  /**
   * Noms d'un dossier (points de montage exclus par chemin) ; null s'il ne s'ouvre pas.
   * Erreur en cours de lecture : les noms déjà lus sont gardés, le dossier compte comme illisible.
   */
  const list = async (d: string, mounts: Set<string>): Promise<string[] | null> => {
    let handle;
    try {
      handle = await fs.opendir(d);
    } catch {
      skipped++;
      return null;
    }
    const names: string[] = [];
    try {
      for await (const ent of handle) {
        if (stop()) break; // quitter la boucle ferme le dossier
        const p = join(d, ent.name);
        if (!mounts.has(p)) names.push(p);
      }
    } catch {
      skipped++;
    }
    return names;
  };

  /** lstat par lots ; null pour une entrée disparue entre-temps. S'arrête au budget. */
  async function* stats(paths: string[]) {
    for (let i = 0; i < paths.length; i += BATCH) {
      if (i > 0 && overTime()) return;
      const chunk = paths.slice(i, i + BATCH);
      const sts = await Promise.all(chunk.map((p) => fs.lstat(p).catch(() => null)));
      for (let j = 0; j < chunk.length; j++) yield [chunk[j], sts[j]] as const;
    }
  }

  const scan = async (): Promise<void> => {
    const mounts = await (o.mountPoints ? o.mountPoints().then((m) => new Set(m)) : mountPointsUnder(root));
    let rootSt;
    try {
      rootSt = await fs.lstat(root);
      if (!rootSt.isDirectory()) throw new Error('ENOTDIR');
    } catch {
      missing = true;
      return;
    }
    const dev = rootSt.dev;
    // 1) premier niveau d'abord : fichiers racine complets et liste des dossiers, avant de descendre
    const names = await list(root, mounts);
    if (names === null) {
      missing = true;
      return;
    }
    for await (const [p, st] of stats(names)) {
      if (!st) continue;
      if (!st.isDirectory()) rootFilesKB += usedKB(st);
      else if (st.dev === dev) tops.push({ path: p, size: usedKB(st), pending: [p], readable: true });
    }
    // 2) descente à tour de rôle (un dossier lu par dossier de premier niveau et par tour) : à l'arrêt, chacun a eu sa part
    for (let active = tops; active.length && !truncated; active = active.filter((t) => t.readable && t.pending.length)) {
      for (const t of active) {
        if (truncated) break;
        const d = t.pending.pop()!;
        const sub = await list(d, mounts);
        if (sub === null) {
          if (d === t.path) t.readable = false; // dossier de premier niveau illisible : ignoré
          continue;
        }
        for await (const [p, st] of stats(sub)) {
          if (!st) continue;
          if (st.isDirectory()) {
            if (st.dev !== dev) continue; // autre système de fichiers : jamais compté
            t.pending.push(p);
          }
          t.size += usedKB(st); // fichier, dossier, ou lien symbolique (le lien lui-même, jamais sa cible)
        }
      }
    }
  };

  return new Promise<TmpUsage>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result());
    };
    // un appel bloqué (FUSE figé) ne doit jamais laisser la liste en « Calcul… » : résultat partiel après le délai dur
    const timer = setTimeout(() => {
      truncated = true;
      finish();
    }, hardTimeoutMs);
    scan().then(finish, () => {
      truncated = true;
      finish();
    });
  });
}

/** Une même occupation de /tmp est réutilisée 30 s ; jamais deux parcours simultanés (le parcours en cours est partagé). */
export function sharedScan(
  scan: () => Promise<TmpUsage> = () => topTmpDirs(),
  { ttlMs = 30_000, now = Date.now }: { ttlMs?: number; now?: () => number } = {},
): () => Promise<TmpUsage> {
  let running: Promise<TmpUsage> | null = null;
  let last: { at: number; usage: TmpUsage } | null = null;
  return () => {
    if (last && now() - last.at < ttlMs) return Promise.resolve(last.usage);
    running ??= scan()
      .then((usage) => {
        last = { at: now(), usage };
        return usage;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
}
