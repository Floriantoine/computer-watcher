// Suppression d'éléments de premier niveau de /tmp (B1 bis). Tout se décide ici, dans le main : le renderer ne fait que
// proposer des noms de la dernière liste ; le main fait confirmer, puis revérifie chaque élément juste avant de le supprimer.
//
// Suppression sûre face à un échange de dossier par un lien pendant la récursion :
//  1. l'élément est déplacé (rename, atomique) dans une quarantaine 0700 de la racine, puis on vérifie que c'est bien
//     l'inode vérifié qui a été déplacé (ino, dev, uid, type) ; sinon rien n'est supprimé et il reste en quarantaine ;
//  2. la récursion est faite par GNU rm (`rm -r --one-file-system`), qui travaille par descripteurs (openat/unlinkat,
//     vérification dev/ino à chaque descente) : un sous-dossier remplacé par un lien n'est jamais suivi, et il ne
//     franchit aucun point de montage. Aucune récursion en JavaScript : fs.rm / rimraf suit un lien substitué.
import { execFile } from 'node:child_process';
import { lstatSync, realpathSync, type BigIntStats } from 'node:fs';
import * as nodeFsp from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cacheLabel, displayName, isTmpDeleteRequest, isValidEntryName, MAX_TMP_DELETE, suspectUser, systemEntry, TEST_ROOT_MARKER, TRASH_PREFIX } from '../core/tmpClean';
import type { TmpConfirmSummary, TmpDeleteItem, TmpDeleteOutcome, TmpDeleteResult, TmpEntry, TmpListing } from '../core/tmpClean';
import type { TmpCleanEvent } from '../core/history/events';
import { mountPointsUnder, topTmpDirs } from './tmpUsage';

/** Sous-ensemble de fs/promises utilisé (le main passe celui d'`original-fs` : aucune réécriture des archives .asar). */
export interface CleanFs {
  lstat(p: string, o: { bigint: true }): Promise<BigIntStats>;
  realpath(p: string): Promise<string>;
  readdir(p: string): Promise<string[]>;
  readlink(p: string): Promise<string>;
  readFile(p: string, enc: 'utf8'): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  rmdir(p: string): Promise<void>;
}
const defaultFs: CleanFs = nodeFsp as unknown as CleanFs;

export interface CleanOptions {
  /** uid de l'utilisateur courant (injectable pour les tests ; 0 : tout refusé). */
  uid?: number;
  fs?: CleanFs;
  /** Points de montage sous la racine (défaut : /proc/self/mountinfo) ; null = illisibles : tout est refusé. */
  mountPoints?: () => Promise<Iterable<string> | null>;
  procRoot?: string;
  /** Durée maximale de la recherche des processus qui utilisent la racine (défaut 3 s) ; dépassée : « impossible de vérifier ». */
  procBudgetMs?: number;
  /** Durée maximale de la suppression (défaut 20 s), vérifiée avant chaque élément. */
  budgetMs?: number;
  /** Délai d'un `rm` (défaut 30 s) : au-delà, SIGKILL et l'élément reste en quarantaine. */
  rmTimeoutMs?: number;
  /** Chemin de GNU rm (défaut /usr/bin/rm). */
  rmPath?: string;
  now?: () => number;
}

const PROC_BUDGET_MS = 3_000;
const DELETE_BUDGET_MS = 20_000;
const RM_TIMEOUT_MS = 30_000;
const RECENT_MS = 5 * 60_000;
const ALLOW_TTL_MS = 10 * 60_000;
const LIST_DIRS = 30;
const LIST_FILES = 20;
const LIST_MAX = 50;
const BATCH = 32;

const usedKB = (st: { blocks: bigint }) => Math.round((Number(st.blocks) * 512) / 1024);
const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const B = (n: number) => BigInt(n);

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
 * sous `root` (/proc/net/unix de l'espace de noms réseau de l'app, rattachés à leur processus par l'inode).
 */
export async function scanTmpUsers(root: string, o: CleanOptions = {}): Promise<TmpUsers> {
  const fs = o.fs ?? defaultFs;
  const proc = o.procRoot ?? '/proc';
  const uid = B(o.uid ?? process.getuid!());
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
      st = await fs.lstat(dir, { bigint: true });
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
  rootDev: bigint;
  uid: number;
  /** null : /proc/self/mountinfo illisible. */
  mounts: Set<string> | null;
  users: TmpUsers;
  fs: CleanFs;
  /** Liste (affichage) : un élément est lstat même si les montages sont illisibles (le parcours des tailles l'a déjà fait). */
  listing?: boolean;
}

type Inspected = { refusal: string; st?: BigIntStats } | { refusal: null; st: BigIntStats };

/** Toutes les conditions de suppression d'un élément de premier niveau ; un point de montage n'est jamais lstat. */
async function inspect(name: string, c: Ctx): Promise<Inspected> {
  if (!isValidEntryName(name)) return { refusal: 'nom invalide' };
  const p = join(c.root, name);
  const noMounts = 'impossible de vérifier (points de montage illisibles)';
  if (c.mounts === null && !c.listing) return { refusal: noMounts };
  if (c.mounts?.has(p)) return { refusal: 'point de montage' }; // jamais de lstat : un montage FUSE figé bloquerait
  let st: BigIntStats;
  try {
    st = await c.fs.lstat(p, { bigint: true });
  } catch {
    return { refusal: 'disparu' };
  }
  if (c.mounts === null) return { refusal: noMounts, st };
  if (c.uid === 0) return { refusal: 'refusé : proc-watch tourne en root', st };
  if (name.startsWith(TRASH_PREFIX)) return { refusal: 'quarantaine de proc-watch (suppression interrompue), à vérifier', st };
  if (systemEntry(name)) return { refusal: 'système', st };
  for (const m of c.mounts) if (m.startsWith(`${p}/`)) return { refusal: 'contient un point de montage', st };
  if (st.uid !== B(c.uid)) return { refusal: 'autre utilisateur', st };
  if (st.isSocket()) return { refusal: 'socket', st };
  if (st.isFIFO()) return { refusal: 'FIFO', st };
  if (st.isBlockDevice() || st.isCharacterDevice()) return { refusal: 'périphérique', st };
  if (!st.isSymbolicLink() && st.dev !== c.rootDev) return { refusal: 'autre système de fichiers', st };
  if (!c.users.complete) return { refusal: 'impossible de vérifier', st };
  const u = c.users.users.get(name);
  if (u) return { refusal: usedBy(u), st };
  const s = suspectUser(name, c.users.uninspectable);
  if (s) return { refusal: `peut-être utilisé par ${s} (non vérifiable)`, st };
  return { refusal: null, st };
}

const kindOf = (st: BigIntStats): TmpEntry['kind'] => (st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file');

/** Points de montage sous `root`, ou null si /proc/self/mountinfo ne se lit pas. */
async function readMounts(root: string, o: CleanOptions): Promise<Set<string> | null> {
  if (o.mountPoints) {
    const m = await o.mountPoints().catch(() => null);
    return m ? new Set(m) : null;
  }
  let ok = false;
  const set = await mountPointsUnder(root, async () => {
    const t = await nodeFsp.readFile('/proc/self/mountinfo', 'utf8');
    ok = true;
    return t;
  });
  return ok ? set : null;
}

async function context(root: string, o: CleanOptions): Promise<Ctx> {
  const fs = o.fs ?? defaultFs;
  const real = await fs.realpath(root);
  const rootSt = await fs.lstat(real, { bigint: true });
  if (!rootSt.isDirectory()) throw new Error('Racine introuvable');
  const [mounts, users] = await Promise.all([readMounts(real, o), scanTmpUsers(real, o)]);
  return { root: real, rootDev: rootSt.dev, uid: o.uid ?? process.getuid!(), mounts, users, fs };
}

/** Fichiers, liens et autres non-dossiers du premier niveau, par place occupée (le lien seul, jamais sa cible). */
async function firstLevelFiles(c: Ctx): Promise<{ name: string; sizeKB: number }[]> {
  let names: string[];
  try {
    names = await c.fs.readdir(c.root);
  } catch {
    return [];
  }
  const mounts = c.mounts ?? new Set<string>();
  names = names.filter((n) => !mounts.has(join(c.root, n))).slice(0, 20_000);
  const out: { name: string; sizeKB: number }[] = [];
  for (let i = 0; i < names.length; i += 64) {
    const chunk = names.slice(i, i + 64);
    const sts = await Promise.all(chunk.map((n) => c.fs.lstat(join(c.root, n), { bigint: true }).catch(() => null)));
    sts.forEach((st, j) => {
      if (st && !st.isDirectory()) out.push({ name: chunk[j], sizeKB: usedKB(st) });
    });
  }
  return out.sort((a, b) => b.sizeKB - a.sizeKB).slice(0, LIST_FILES);
}

/** GNU rm (coreutils) présent à `rmPath` : null si oui, sinon la raison (la suppression est alors désactivée). */
export function checkGnuRm(rmPath = '/usr/bin/rm'): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(rmPath, ['--version'], { timeout: 5_000, env: { LC_ALL: 'C' } }, (err, stdout) => {
      if (!err && /^rm \(GNU coreutils\) /.test(String(stdout))) resolve(null);
      else resolve(`suppression désactivée : ${rmPath} n'est pas GNU rm (coreutils)`);
    });
  });
}

/** `rm -r --one-file-system -- path`, sans shell ; délai puis SIGKILL. Se règle toujours (même si rm reste bloqué). */
function runRm(rmPath: string, path: string, timeoutMs: number): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: { ok: true } | { ok: false; error: string }) => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      resolve(r);
    };
    // un rm en sommeil ininterruptible (FUSE figé) ne meurt pas tout de suite : on n'attend pas sa sortie
    const guard = setTimeout(() => finish({ ok: false, error: 'délai dépassé (montage figé ?)' }), timeoutMs + 1_000);
    execFile(rmPath, ['-r', '--one-file-system', '--', path], { timeout: timeoutMs, killSignal: 'SIGKILL', env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' } }, (err, _o, stderr) => {
      if (!err) return finish({ ok: true });
      if ((err as { killed?: boolean }).killed) return finish({ ok: false, error: 'délai dépassé (montage figé ?)' });
      const line = String(stderr).trim().split('\n')[0] || String((err as Error).message);
      finish({ ok: false, error: line.replace(/^\S*rm: /, '').slice(0, 200) });
    });
  });
}

interface Allowed {
  ino: bigint;
  dev: bigint;
  uid: bigint;
  kind: TmpEntry['kind'];
  sizeKB: number;
  recent: boolean;
  at: number;
}

export interface CleanerOptions extends CleanOptions {
  /** Confirmation native dans le main : liste exacte des chemins et taille totale. Faux : rien n'est touché. */
  confirm: (s: TmpConfirmSummary) => Promise<boolean>;
  /** Durée de validité de la dernière liste (défaut 10 min). */
  allowTtlMs?: number;
}

export interface TmpCleaner {
  list(): Promise<TmpListing>;
  delete(items: unknown): Promise<TmpDeleteOutcome>;
}

/**
 * Nettoyeur d'une racine : `list` affiche les éléments et retient ceux qui sont supprimables (nom + ino + dev + uid) ;
 * `delete` n'accepte que ceux-là, fait confirmer par le main, puis revérifie et supprime chacun (quarantaine + GNU rm).
 */
export function createTmpCleaner(root: string, o: CleanerOptions): TmpCleaner {
  const fs = o.fs ?? defaultFs;
  const rmPath = o.rmPath ?? '/usr/bin/rm';
  const now = o.now ?? Date.now;
  const ttl = o.allowTtlMs ?? ALLOW_TTL_MS;
  let rmCheck: Promise<string | null> | null = null;
  const disabled = () => (rmCheck ??= checkGnuRm(rmPath));
  let allowed = new Map<string, Allowed>();
  let busy = false;

  async function list(): Promise<TmpListing> {
    const [c0, off] = await Promise.all([context(root, o), disabled()]);
    const c = { ...c0, listing: true };
    const [usage, files] = await Promise.all([
      topTmpDirs(c.root, { limit: LIST_DIRS, mountPoints: async () => c.mounts ?? [] }),
      firstLevelFiles(c),
    ]);
    const sized = [...usage.dirs.map((d) => ({ name: d.path.slice(c.root.length + 1), sizeKB: d.sizeKB })), ...files]
      .sort((a, b) => b.sizeKB - a.sizeKB)
      .slice(0, LIST_MAX);
    const entries: TmpEntry[] = [];
    const next = new Map<string, Allowed>();
    const wall = Date.now();
    for (const s of sized) {
      const r = await inspect(s.name, c);
      if (!r.st) continue; // disparu entre-temps
      const recent = wall - Number(r.st.mtimeMs) < RECENT_MS;
      const refusal = off ?? r.refusal;
      const kind = kindOf(r.st);
      entries.push({ name: s.name, ino: String(r.st.ino), dev: String(r.st.dev), kind, sizeKB: s.sizeKB, cache: cacheLabel(s.name), recent, refusal });
      if (refusal === null) next.set(s.name, { ino: r.st.ino, dev: r.st.dev, uid: r.st.uid, kind, sizeKB: s.sizeKB, recent, at: now() });
    }
    allowed = next;
    return { root, entries, truncated: usage.truncated, uninspectable: c.users.uninspectable, disabled: off };
  }

  async function del(raw: unknown): Promise<TmpDeleteOutcome> {
    if (!isTmpDeleteRequest(raw)) throw new Error(`Requête invalide (1 à ${MAX_TMP_DELETE} éléments)`);
    if (busy) throw new Error('Une suppression est déjà en cours');
    busy = true;
    try {
      return await run(raw);
    } finally {
      busy = false;
    }
  }

  async function run(raw: TmpDeleteItem[]): Promise<TmpDeleteOutcome> {
    const items: TmpDeleteItem[] = [];
    const seen = new Set<string>();
    for (const i of raw) {
      if (seen.has(i.name)) continue;
      seen.add(i.name);
      items.push({ name: i.name, ino: i.ino, dev: i.dev });
    }
    const results = new Map<string, TmpDeleteResult>();
    const refuse = (name: string, reason: string) => results.set(name, { name, ok: false, reason });
    const ordered = (): TmpDeleteResult[] => items.map((i) => results.get(i.name)!);
    const off = await disabled();
    if (off) {
      for (const i of items) refuse(i.name, off);
      return { results: ordered(), freedKB: 0 };
    }
    // 1) seulement des éléments supprimables de la dernière liste, identiques (nom, ino, dev), encore valides
    const candidates: { item: TmpDeleteItem; a: Allowed }[] = [];
    for (const i of items) {
      if (!isValidEntryName(i.name)) {
        refuse(i.name, 'nom invalide');
        continue;
      }
      const a = allowed.get(i.name);
      if (!a || String(a.ino) !== i.ino || String(a.dev) !== i.dev || now() - a.at > ttl) {
        refuse(i.name, 'pas dans la dernière liste affichée');
        continue;
      }
      candidates.push({ item: i, a });
    }
    if (!candidates.length) return { results: ordered(), freedKB: 0 };
    // 2) confirmation native, chemins exacts
    const c0 = await context(root, o);
    const summary: TmpConfirmSummary = {
      root: c0.root,
      items: candidates.map(({ item, a }) => ({ name: item.name, kind: a.kind, sizeKB: a.sizeKB, recent: a.recent })),
      totalKB: candidates.reduce((s, x) => s + x.a.sizeKB, 0),
      uninspectable: c0.users.uninspectable,
    };
    if (!(await o.confirm(summary))) {
      for (const { item } of candidates) refuse(item.name, 'annulé');
      return { results: ordered(), freedKB: 0, cancelled: true };
    }
    // 3) revérification complète juste avant chaque suppression (état relu après la confirmation)
    const c = await context(root, o);
    const budget = o.budgetMs ?? DELETE_BUDGET_MS;
    const start = now();
    let freedKB = 0;
    let partial = false;
    let trash: string | null = null;
    for (const { item, a } of candidates) {
      if (now() - start > budget) {
        refuse(item.name, 'temps écoulé');
        continue;
      }
      const r = await inspect(item.name, c);
      if (r.refusal === 'disparu') {
        refuse(item.name, 'disparu');
        continue;
      }
      if (r.st && (r.st.ino !== a.ino || r.st.dev !== a.dev || r.st.uid !== a.uid || kindOf(r.st) !== a.kind)) {
        refuse(item.name, 'a changé depuis l’affichage');
        continue;
      }
      if (r.refusal !== null) {
        refuse(item.name, r.refusal);
        continue;
      }
      const p = join(c.root, item.name);
      if (a.kind !== 'link') {
        const real = await fs.realpath(p).catch(() => null);
        if (real !== p) {
          refuse(item.name, 'hors de la racine');
          continue;
        }
      }
      try {
        trash ??= await fs.mkdtemp(join(c.root, TRASH_PREFIX)); // 0700, même système de fichiers
      } catch (e) {
        refuse(item.name, `échec de la quarantaine : ${code(e) ?? 'erreur'}`);
        continue;
      }
      const moved = join(trash, item.name);
      try {
        await fs.rename(p, moved);
      } catch (e) {
        refuse(item.name, `échec du déplacement : ${code(e) ?? 'erreur'}`);
        continue;
      }
      const m = await fs.lstat(moved, { bigint: true }).catch(() => null);
      if (!m || m.ino !== a.ino || m.dev !== a.dev || m.uid !== a.uid || kindOf(m) !== a.kind) {
        refuse(item.name, `élément remplacé pendant la suppression, laissé dans ${trash}`);
        continue;
      }
      const rm = await runRm(rmPath, moved, o.rmTimeoutMs ?? RM_TIMEOUT_MS);
      if (rm.ok) {
        results.set(item.name, { name: item.name, ok: true });
        freedKB += a.sizeKB;
      } else {
        partial = true;
        refuse(item.name, `échec : ${rm.error} ; le reste est dans ${trash}`);
      }
    }
    if (trash) await fs.rmdir(trash).catch(() => {}); // non vide : laissée (éléments remplacés ou échecs), signalée
    return { results: ordered(), freedKB, ...(partial ? { partial } : {}) };
  }

  return { list, delete: del };
}

/** Texte de la confirmation native (titre et détail), noms échappés. */
export function confirmText(s: TmpConfirmSummary, formatKB: (kb: number) => string): { message: string; detail: string } {
  const n = s.items.length;
  const lines = s.items.map((i) => {
    const d = displayName(i.name);
    const suffix = i.kind === 'link' ? ' (le lien seul)' : i.kind === 'dir' ? '/' : '';
    return `${d.escaped ? '⚠ ' : ''}${s.root}/${d.text}${suffix} — ${formatKB(i.sizeKB)}${i.recent ? ' — ⚠ modifié il y a moins de 5 min' : ''}`;
  });
  const parts = [lines.join('\n'), `Total : ${formatKB(s.totalKB)}`, "C'est définitif, la corbeille ne libérerait pas la RAM (elle est sur disque)."];
  if (s.uninspectable.length) {
    const names = [...new Set(s.uninspectable.map((p) => p.name))].join(', ');
    parts.push(`Non vérifiable : un fichier ouvert par ces processus à droits élevés ne serait pas détecté : ${names}.`);
  }
  parts.push("Les sockets des applications isolées (flatpak, bac à sable de Chromium) ne sont pas vus : /proc/net/unix ne montre que l'espace de noms réseau de proc-watch.");
  return { message: `Supprimer définitivement ${n > 1 ? `ces ${n} éléments` : 'cet élément'} de ${s.root} ?`, detail: parts.join('\n\n') };
}

/**
 * Racine nettoyable : toujours /tmp, sauf pour les vérifications de l'app (jamais dans la vraie /tmp) : `PROC_WATCH_TMP_ROOT`
 * n'est retenu que si son chemin réel est un dossier strictement sous `~/.cache/pw-…` et qu'il contient le fichier témoin
 * `.proc-watch-test-root`. Sinon : /tmp, avec un avertissement.
 */
export function tmpRootFromEnv(env: NodeJS.ProcessEnv, home = homedir()): { root: string; warning: string | null } {
  const r = env.PROC_WATCH_TMP_ROOT;
  if (r === undefined || r === '') return { root: '/tmp', warning: null };
  const refuse = (why: string) => ({ root: '/tmp', warning: `PROC_WATCH_TMP_ROOT ignoré (${why}) : racine /tmp` });
  try {
    const real = realpathSync(r);
    const cache = realpathSync(join(home, '.cache'));
    if (!real.startsWith(`${cache}/pw-`)) return refuse('pas sous ~/.cache/pw-');
    if (!lstatSync(real).isDirectory()) return refuse('pas un dossier');
    if (!lstatSync(join(real, TEST_ROOT_MARKER)).isFile()) return refuse(`pas de fichier ${TEST_ROOT_MARKER}`);
    return { root: real, warning: null };
  } catch {
    return refuse(`introuvable ou sans fichier ${TEST_ROOT_MARKER}`);
  }
}

/** Événement du journal après une suppression : si quelque chose a été supprimé, ou supprimé en partie. */
export function tmpCleanEvent(o: TmpDeleteOutcome, ts: number): TmpCleanEvent | null {
  const deleted = o.results.filter((r) => r.ok).map((r) => r.name);
  if (!deleted.length && !o.partial) return null;
  const refused = o.results.filter((r) => !r.ok).map((r) => ({ name: r.name, reason: r.reason ?? 'refusé' }));
  return { ts, type: 'tmp_clean', groupKey: null, detail: { freedKB: o.freedKB, deleted, refused, ...(o.partial ? { partial: true } : {}) } };
}
