// Racines temporaires des lancements de Vitest, sur disque sous ~/.cache/pw-vitest (jamais dans /tmp, qui est en RAM).
// Chaque racine porte son propriétaire dans son NOM, créé d'un coup par mkdtemp : `<pid>-<starttime>-<pidns>-XXXXXX`
// (pid du processus principal de Vitest, champ 22 de /proc/<pid>/stat, espace de noms de pid). Aucune fenêtre où une
// racine existe sans propriétaire connu ; un lancement tué (earlyoom, timeout, Ctrl-C, scope plafonné) laisse une racine
// dont le propriétaire est mort : le lancement suivant la purge.
import { chmodSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseMountinfo } from '../core/mountinfo';

/** Processus principal de Vitest qui possède une racine. `start` : starttime (tops d'horloge depuis le démarrage). */
export interface RootOwner {
  pid: number;
  start: string;
  /** Inode de l'espace de noms de pid (« pid:[4026531836] ») ; « 0 » s'il est illisible. */
  ns: string;
}

/** starttime (champ 22 de /proc/<pid>/stat), lu après la dernière parenthèse (le nom peut en contenir) ; null si illisible. */
export function readStartTime(pid: number | 'self', procRoot = '/proc'): string | null {
  let stat: string;
  try {
    stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
  } catch {
    return null;
  }
  const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return /^\d+$/.test(f[19] ?? '') ? f[19] : null;
}

function pidNamespace(procRoot = '/proc'): string {
  try {
    return /^pid:\[(\d+)\]$/.exec(readlinkSync(join(procRoot, 'self', 'ns', 'pid')))?.[1] ?? '0';
  } catch {
    return '0';
  }
}

/** Le processus courant (appelé dans le processus principal de Vitest, par le globalSetup). */
export function selfOwner(): RootOwner {
  return { pid: process.pid, start: readStartTime('self') ?? '0', ns: pidNamespace() };
}

/** Préfixe passé à mkdtemp (qui ajoute 6 caractères [A-Za-z0-9]). */
export const rootPrefix = (o: RootOwner): string => `${o.pid}-${o.start}-${o.ns}-`;

const NAME = /^([1-9]\d{0,9})-(\d{1,20})-(\d{1,20})-[A-Za-z0-9]{6}$/;

/** Propriétaire d'après le nom d'une racine ; null pour tout autre nom (jamais purgé). */
export function parseRootName(name: string): RootOwner | null {
  const m = NAME.exec(name);
  return m ? { pid: Number(m[1]), start: m[2], ns: m[3] } : null;
}

/**
 * Vrai seulement sur preuve que le propriétaire est mort : même espace de noms de pid que nous, et /proc/<pid> absent,
 * ou présent avec un autre starttime (pid réutilisé). Autre espace de noms (conteneur, flatpak), stat illisible ou mal
 * formé : faux (la racine est gardée).
 */
export function ownerDead(o: RootOwner, ctx: { ns: string; procRoot?: string }): boolean {
  if (o.ns !== ctx.ns || o.ns === '0') return false;
  const procRoot = ctx.procRoot ?? '/proc';
  let stat: string;
  try {
    stat = readFileSync(join(procRoot, String(o.pid), 'stat'), 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
  const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  if (!/^\d+$/.test(f[19] ?? '')) return false;
  return f[19] !== o.start;
}

const errCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? String(e);
const MAX_ERRORS = 20;

/**
 * Supprime `path` et tout ce qu'il contient, sans jamais suivre un lien (lstat ; un lien est supprimé, sa cible jamais
 * touchée) ni franchir un point de montage (`mounts`, puis système de fichiers différent de celui de `path`). Chaque
 * dossier est rendu u+rwx avant d'être lu (les tests en laissent en 0o500 ou 0o000 : rm échouerait). ENOENT toléré
 * (deux purges peuvent passer en même temps). Arrêt à `deadline` (horloge `now`) : le reste sera repris plus tard.
 */
export function removeTree(
  path: string,
  o: { mounts?: ReadonlySet<string>; deadline?: number; now?: () => number } = {},
): { removed: boolean; errors: string[] } {
  const now = o.now ?? Date.now;
  const errors: string[] = [];
  const fail = (p: string, why: string) => {
    if (errors.length < MAX_ERRORS) errors.push(`${p} : ${why}`);
    return false;
  };
  let dev: number | null = null;
  let late = false;
  /** Vrai si `p` n'existe plus. */
  const rm = (p: string): boolean => {
    if (late || (o.deadline !== undefined && now() > o.deadline)) {
      if (!late) errors.push('temps écoulé');
      late = true;
      return false;
    }
    if (o.mounts?.has(p)) return fail(p, 'point de montage');
    let st;
    try {
      st = lstatSync(p);
    } catch (e) {
      return errCode(e) === 'ENOENT' || fail(p, errCode(e));
    }
    dev ??= st.dev;
    if (!st.isDirectory()) {
      try {
        unlinkSync(p);
        return true;
      } catch (e) {
        return errCode(e) === 'ENOENT' || fail(p, errCode(e));
      }
    }
    if (st.dev !== dev) return fail(p, 'autre système de fichiers');
    if ((st.mode & 0o700) !== 0o700) {
      try {
        chmodSync(p, (st.mode & 0o7777) | 0o700);
      } catch (e) {
        if (errCode(e) === 'ENOENT') return true;
        fail(p, errCode(e));
      }
    }
    let names: string[];
    try {
      names = readdirSync(p);
    } catch (e) {
      return errCode(e) === 'ENOENT' || fail(p, errCode(e));
    }
    let all = true;
    for (const n of names) all = rm(join(p, n)) && all;
    if (!all) return false;
    try {
      rmdirSync(p);
      return true;
    } catch (e) {
      return errCode(e) === 'ENOENT' || fail(p, errCode(e));
    }
  };
  return { removed: rm(path), errors };
}

/** Durée maximale de la purge au lancement : le reste est repris au lancement suivant. */
const PURGE_BUDGET_MS = 30_000;

/**
 * Purge les racines orphelines de `base` (~/.cache/pw-vitest) : seulement les dossiers au nom exact `<pid>-<starttime>-
 * <pidns>-XXXXXX` dont le propriétaire est mort (voir ownerDead). Jamais une racine vivante, d'un autre espace de noms,
 * au nom inconnu, un lien ou un fichier, ni une racine qui contient un point de montage (mountinfo illisible : rien).
 * Pas de critère d'âge : une suite longue (mode watch) garde sa racine tant que son processus vit.
 */
export function purgeOrphanRoots(
  base: string,
  o: { procRoot?: string; ns?: string; mountinfo?: () => string; budgetMs?: number; now?: () => number } = {},
): { purged: string[]; errors: string[] } {
  // chemin réel : les points de montage de mountinfo le sont aussi (~/.cache peut être un lien)
  let real: string;
  try {
    real = realpathSync(base);
  } catch {
    return { purged: [], errors: [] };
  }
  if (basename(real) !== 'pw-vitest') throw new Error(`purge refusée hors d'un dossier pw-vitest : ${base}`);
  const now = o.now ?? Date.now;
  const deadline = now() + (o.budgetMs ?? PURGE_BUDGET_MS);
  const ns = o.ns ?? selfOwner().ns;
  const purged: string[] = [];
  const errors: string[] = [];
  let names: string[];
  try {
    names = readdirSync(real);
  } catch {
    return { purged, errors };
  }
  const dead = names.filter((n) => {
    const owner = parseRootName(n);
    return owner !== null && ownerDead(owner, { ns, procRoot: o.procRoot });
  });
  if (!dead.length) return { purged, errors };
  let mounts: string[];
  try {
    mounts = parseMountinfo((o.mountinfo ?? (() => readFileSync('/proc/self/mountinfo', 'utf8')))()).map((m) => m.mount);
  } catch {
    errors.push(`${real} : points de montage illisibles, rien n'est purgé`);
    return { purged, errors };
  }
  for (const name of dead) {
    const p = join(real, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (mounts.some((m) => m === p || m.startsWith(`${p}/`))) {
      errors.push(`${p} : contient un point de montage, gardée`);
      continue;
    }
    const r = removeTree(p, { mounts: new Set(mounts), deadline, now });
    if (r.removed) purged.push(name);
    else errors.push(...r.errors.slice(0, 3));
  }
  return { purged, errors };
}
