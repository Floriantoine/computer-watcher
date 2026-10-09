// Suppression d'éléments de premier niveau de /tmp (B1 bis). Tout se décide ici, dans le main : le renderer ne fait que
// proposer des noms ; chaque condition est revérifiée juste avant de supprimer (TOCTOU : inode, périphérique, propriétaire).
import * as nodeFsp from 'node:fs/promises';
import { join } from 'node:path';
import { cacheLabel, isTmpDeleteRequest, isValidEntryName, MAX_TMP_DELETE, systemEntry } from '../core/tmpClean';
import type { TmpDeleteItem, TmpDeleteOutcome, TmpDeleteResult, TmpEntry, TmpListing } from '../core/tmpClean';
import type { TmpCleanEvent } from '../core/history/events';
import { mountPointsUnder, topTmpDirs } from './tmpUsage';

type Stat = import('node:fs').Stats;

/** Sous-ensemble de fs/promises utilisé (le main passe celui d'`original-fs` : aucune réécriture des archives .asar). */
export interface CleanFs {
  lstat(p: string): Promise<Stat>;
  realpath(p: string): Promise<string>;
  readdir(p: string): Promise<string[]>;
  readlink(p: string): Promise<string>;
  readFile(p: string, enc: 'utf8'): Promise<string>;
  unlink(p: string): Promise<void>;
  rm(p: string, o: { recursive: boolean; force: boolean }): Promise<void>;
}
const defaultFs: CleanFs = nodeFsp as unknown as CleanFs;

export interface CleanOptions {
  /** uid de l'utilisateur courant (injectable pour les tests ; 0 : tout refusé). */
  uid?: number;
  fs?: CleanFs;
  /** Points de montage (défaut : /proc/self/mountinfo). */
  mountPoints?: () => Promise<Iterable<string>>;
  procRoot?: string;
  /** Durée maximale de la recherche des processus qui utilisent la racine (défaut 3 s) ; dépassée : « impossible de vérifier ». */
  procBudgetMs?: number;
  /** Durée maximale de la suppression (défaut 20 s), vérifiée avant chaque élément. */
  budgetMs?: number;
  now?: () => number;
}

const PROC_BUDGET_MS = 3_000;
const DELETE_BUDGET_MS = 20_000;
const LIST_DIRS = 30;
const LIST_FILES = 20;
const LIST_MAX = 50;
const BATCH = 32;

const usedKB = (st: { blocks: number }) => Math.round((st.blocks * 512) / 1024);
const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code;

export interface TmpUsers {
  /** Nom de premier niveau → un processus qui l'utilise (fd, cwd, exe, maps, ou socket Unix lié dedans). */
  users: Map<string, { pid: number; name: string }>;
  /** Faux si le budget a été dépassé ou /proc illisible : rien ne peut alors être déclaré libre. */
  complete: boolean;
  /** Processus de l'utilisateur dont fd/maps sont illisibles (non « dumpables », capacités) : non vérifiables. */
  uninspectable: { pid: number; name: string }[];
}

/**
 * Processus qui utilisent quelque chose sous `root` (chemin réel) : liens fd/cwd/exe, lignes de maps, et sockets Unix liés
 * sous `root` (/proc/net/unix, rattachés à leur processus par l'inode). Seuls les processus de l'utilisateur sont lus.
 */
export async function scanTmpUsers(root: string, o: CleanOptions = {}): Promise<TmpUsers> {
  const fs = o.fs ?? defaultFs;
  const proc = o.procRoot ?? '/proc';
  const uid = o.uid ?? process.getuid!();
  const budget = o.procBudgetMs ?? PROC_BUDGET_MS;
  const start = Date.now();
  const prefix = root.endsWith('/') ? root : `${root}/`;
  const users = new Map<string, { pid: number; name: string }>();
  const sockets = new Map<string, { pid: number; name: string }>();
  const uninspectable: { pid: number; name: string }[] = [];
  let complete = true;
  const over = () => Date.now() - start >= budget;

  const topOf = (p: string): string | null => {
    if (!p.startsWith(prefix)) return null;
    const rest = p.slice(prefix.length);
    const i = rest.indexOf('/');
    return i < 0 ? rest.replace(/ \(deleted\)$/, '') : rest.slice(0, i);
  };
  const mark = (p: string, who: { pid: number; name: string }) => {
    const t = topOf(p);
    if (t && !users.has(t)) users.set(t, who);
  };

  const one = async (pid: number) => {
    const dir = `${proc}/${pid}`;
    let st;
    try {
      st = await fs.lstat(dir);
    } catch {
      return; // disparu
    }
    if (st.uid !== uid) return;
    const name = (await fs.readFile(`${dir}/comm`, 'utf8').catch(() => '?')).trim() || '?';
    const who = { pid, name };
    let fds: string[];
    try {
      fds = await fs.readdir(`${dir}/fd`);
    } catch (e) {
      if (code(e) === 'ENOENT' || code(e) === 'ESRCH') return;
      uninspectable.push(who);
      return;
    }
    const links = await Promise.all([
      ...fds.map((fd) => fs.readlink(`${dir}/fd/${fd}`).catch(() => null)),
      fs.readlink(`${dir}/cwd`).catch(() => null),
      fs.readlink(`${dir}/exe`).catch(() => null),
    ]);
    for (const l of links) {
      if (!l) continue;
      const s = /^socket:\[(\d+)\]$/.exec(l);
      if (s) sockets.set(s[1], who);
      else mark(l, who);
    }
    const maps = await fs.readFile(`${dir}/maps`, 'utf8').catch(() => '');
    for (let i = maps.indexOf(prefix); i >= 0; i = maps.indexOf(prefix, i + 1)) {
      // le chemin est le dernier champ de la ligne, précédé d'espaces
      if (maps[i - 1] !== ' ') continue;
      const end = maps.indexOf('\n', i);
      mark(maps.slice(i, end < 0 ? undefined : end), who);
    }
  };

  const scan = async () => {
    let pids: number[];
    try {
      pids = (await fs.readdir(proc)).filter((n) => /^\d+$/.test(n)).map(Number);
    } catch {
      complete = false;
      return;
    }
    for (let i = 0; i < pids.length; i += BATCH) {
      if (over()) {
        complete = false;
        return;
      }
      await Promise.all(pids.slice(i, i + BATCH).map(one));
    }
    // sockets Unix liés sous la racine (le fd du processus ne montre que « socket:[inode] »)
    let unix: string;
    try {
      unix = await fs.readFile(`${proc}/net/unix`, 'utf8');
    } catch {
      complete = false;
      return;
    }
    for (const line of unix.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 8) continue;
      const path = f.slice(7).join(' ');
      const t = topOf(path);
      if (t && !users.has(t)) users.set(t, sockets.get(f[6]) ?? { pid: 0, name: 'un socket' });
    }
    if (over()) complete = false;
  };

  if (budget <= 0) return { users, complete: false, uninspectable };
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      complete = false;
      resolve();
    }, budget + 500);
    scan().then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        complete = false;
        clearTimeout(timer);
        resolve();
      },
    );
  });
  return { users: new Map(users), complete, uninspectable: [...uninspectable] };
}

const usedBy = (u: { pid: number; name: string }) => (u.pid ? `utilisé par ${u.name} (pid ${u.pid})` : `utilisé par ${u.name}`);

interface Ctx {
  root: string;
  rootDev: number;
  uid: number;
  mounts: Set<string>;
  users: TmpUsers;
  fs: CleanFs;
}

type Inspected = { refusal: string; st?: Stat } | { refusal: null; st: Stat };

/** Toutes les conditions de suppression d'un élément de premier niveau ; le montage est écarté avant tout lstat. */
async function inspect(name: string, c: Ctx): Promise<Inspected> {
  if (!isValidEntryName(name)) return { refusal: 'nom invalide' };
  const p = join(c.root, name);
  if (c.mounts.has(p)) return { refusal: 'point de montage' }; // jamais de lstat : un montage FUSE figé bloquerait
  let st: Stat;
  try {
    st = await c.fs.lstat(p);
  } catch {
    return { refusal: 'disparu' };
  }
  if (c.uid === 0) return { refusal: 'refusé : proc-watch tourne en root', st };
  if (systemEntry(name)) return { refusal: 'système', st };
  for (const m of c.mounts) if (m.startsWith(`${p}/`)) return { refusal: 'contient un point de montage', st };
  if (st.uid !== c.uid) return { refusal: 'autre utilisateur', st };
  if (st.isSocket()) return { refusal: 'socket', st };
  if (st.isFIFO()) return { refusal: 'FIFO', st };
  if (st.isBlockDevice() || st.isCharacterDevice()) return { refusal: 'périphérique', st };
  if (!st.isSymbolicLink() && st.dev !== c.rootDev) return { refusal: 'autre système de fichiers', st };
  if (!c.users.complete) return { refusal: 'impossible de vérifier', st };
  const u = c.users.users.get(name);
  if (u) return { refusal: usedBy(u), st };
  return { refusal: null, st };
}

const kindOf = (st: Stat): TmpEntry['kind'] => (st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file');

async function context(root: string, o: CleanOptions): Promise<Ctx> {
  const fs = o.fs ?? defaultFs;
  const real = await fs.realpath(root);
  const rootSt = await fs.lstat(real);
  if (!rootSt.isDirectory()) throw new Error('Racine introuvable');
  const [mounts, users] = await Promise.all([
    o.mountPoints ? o.mountPoints().then((m) => new Set(m)) : mountPointsUnder(real),
    scanTmpUsers(real, o),
  ]);
  return { root: real, rootDev: rootSt.dev, uid: o.uid ?? process.getuid!(), mounts, users, fs };
}

/**
 * Plus gros éléments de premier niveau de `root` (dossiers par taille parcourue, fichiers et liens par leur propre taille),
 * chacun avec sa raison de refus éventuelle. Les points de montage ne sont ni parcourus ni affichés.
 */
export async function listTmpEntries(root = '/tmp', o: CleanOptions = {}): Promise<TmpListing> {
  const c = await context(root, o);
  const [usage, files] = await Promise.all([
    topTmpDirs(c.root, { limit: LIST_DIRS, mountPoints: async () => c.mounts }),
    firstLevelFiles(c),
  ]);
  const sized = [
    ...usage.dirs.map((d) => ({ name: d.path.slice(c.root.length + 1), sizeKB: d.sizeKB })),
    ...files,
  ].sort((a, b) => b.sizeKB - a.sizeKB).slice(0, LIST_MAX);
  const entries: TmpEntry[] = [];
  for (const s of sized) {
    const r = await inspect(s.name, c);
    if (!r.st) continue; // disparu entre-temps
    entries.push({ name: s.name, ino: r.st.ino, dev: r.st.dev, kind: kindOf(r.st), sizeKB: s.sizeKB, cache: cacheLabel(s.name), refusal: r.refusal });
  }
  return { root, entries, truncated: usage.truncated, uninspectable: c.users.uninspectable };
}

/** Fichiers, liens et autres non-dossiers du premier niveau, par place occupée (le lien seul, jamais sa cible). */
async function firstLevelFiles(c: Ctx): Promise<{ name: string; sizeKB: number }[]> {
  let names: string[];
  try {
    names = await c.fs.readdir(c.root);
  } catch {
    return [];
  }
  names = names.filter((n) => !c.mounts.has(join(c.root, n))).slice(0, 20_000);
  const out: { name: string; sizeKB: number }[] = [];
  for (let i = 0; i < names.length; i += 64) {
    const chunk = names.slice(i, i + 64);
    const sts = await Promise.all(chunk.map((n) => c.fs.lstat(join(c.root, n)).catch(() => null)));
    sts.forEach((st, j) => {
      if (st && !st.isDirectory()) out.push({ name: chunk[j], sizeKB: usedKB(st) });
    });
  }
  return out.sort((a, b) => b.sizeKB - a.sizeKB).slice(0, LIST_FILES);
}

/**
 * Supprime les éléments demandés, un par un, après revérification complète de chacun : mêmes inode et périphérique
 * qu'à l'affichage, toujours à l'utilisateur, chemin réel dans la racine, pas utilisé. Liens supprimés eux-mêmes
 * (unlink), dossiers par `rm` récursif qui ne suit aucun lien. Au-delà du budget : « temps écoulé ».
 */
export async function deleteTmpEntries(root: string, items: TmpDeleteItem[], o: CleanOptions = {}): Promise<TmpDeleteOutcome> {
  if (!isTmpDeleteRequest(items)) throw new Error(`Requête invalide (1 à ${MAX_TMP_DELETE} éléments)`);
  const now = o.now ?? Date.now;
  const budget = o.budgetMs ?? DELETE_BUDGET_MS;
  const c = await context(root, o);
  const start = now();
  const results: TmpDeleteResult[] = [];
  let freedKB = 0;
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.name)) continue;
    seen.add(it.name);
    if (now() - start > budget) {
      results.push({ name: it.name, ok: false, reason: 'temps écoulé' });
      continue;
    }
    const r = await deleteOne(it, c);
    results.push(r.result);
    freedKB += r.kb;
  }
  return { results, freedKB };
}

/** Place occupée sous `p` (dossier), sans suivre aucun lien ni changer de système de fichiers ; au plus 200 000 entrées. */
async function measureKB(p: string, dev: number, fs: CleanFs): Promise<number> {
  let kb = 0;
  let n = 0;
  const stack = [p];
  while (stack.length && n < 200_000) {
    const d = stack.pop()!;
    const names = await fs.readdir(d).catch(() => [] as string[]);
    for (let i = 0; i < names.length; i += 64) {
      const qs = names.slice(i, i + 64).map((name) => join(d, name));
      const sts = await Promise.all(qs.map((q) => fs.lstat(q).catch(() => null)));
      n += qs.length;
      sts.forEach((st, j) => {
        if (!st) return;
        kb += (st.blocks * 512) / 1024;
        if (st.isDirectory() && st.dev === dev) stack.push(qs[j]);
      });
    }
  }
  return kb;
}

async function deleteOne(it: TmpDeleteItem, c: Ctx): Promise<{ result: TmpDeleteResult; kb: number }> {
  const refuse = (reason: string) => ({ result: { name: it.name, ok: false, reason } as TmpDeleteResult, kb: 0 });
  const r = await inspect(it.name, c);
  if (r.refusal === 'disparu') return refuse('disparu');
  if (r.st && (r.st.ino !== it.ino || r.st.dev !== it.dev)) return refuse('a changé depuis l’affichage');
  if (r.refusal !== null) return refuse(r.refusal);
  const p = join(c.root, it.name);
  const link = r.st.isSymbolicLink();
  if (!link) {
    // chemin réel : identique au chemin construit (aucun lien sur le trajet), donc dans la racine
    const real = await c.fs.realpath(p).catch(() => null);
    if (real !== p) return refuse('hors de la racine');
  }
  // dernier contrôle, au plus près de la suppression
  const last = await c.fs.lstat(p).catch(() => null);
  if (!last || last.ino !== it.ino || last.dev !== it.dev || last.isSymbolicLink() !== link) return refuse('a changé depuis l’affichage');
  const dir = !link && last.isDirectory();
  // place libérée : mesurée avant (un statfs après coup ne voit pas toujours la place rendue tout de suite)
  const kb = (last.blocks * 512) / 1024 + (dir ? await measureKB(p, last.dev, c.fs) : 0);
  try {
    if (dir) await c.fs.rm(p, { recursive: true, force: false });
    else await c.fs.unlink(p);
    return { result: { name: it.name, ok: true }, kb: Math.round(kb) };
  } catch (e) {
    return refuse(`échec : ${code(e) ?? 'erreur'}`);
  }
}

/**
 * Racine nettoyable : toujours /tmp, sauf pour les vérifications de l'app (jamais dans la vraie /tmp) :
 * `PROC_WATCH_TMP_ROOT` n'est lu que s'il est absolu et différent de « / », que NODE_ENV n'est pas « production »
 * et que l'app n'est pas empaquetée.
 */
export function tmpRootFromEnv(env: NodeJS.ProcessEnv, packaged: boolean): string {
  const r = env.PROC_WATCH_TMP_ROOT;
  if (!r || packaged || env.NODE_ENV === 'production' || !r.startsWith('/') || r.replace(/\/+$/, '') === '') return '/tmp';
  return r;
}

/** Événement du journal après une suppression ; null si rien n'a été supprimé. */
export function tmpCleanEvent(o: TmpDeleteOutcome, ts: number): TmpCleanEvent | null {
  const deleted = o.results.filter((r) => r.ok).map((r) => r.name);
  if (!deleted.length) return null;
  const refused = o.results.filter((r) => !r.ok).map((r) => ({ name: r.name, reason: r.reason ?? 'refusé' }));
  return { ts, type: 'tmp_clean', groupKey: null, detail: { freedKB: o.freedKB, deleted, refused } };
}
