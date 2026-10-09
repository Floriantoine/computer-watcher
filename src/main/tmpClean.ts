// Suppression d'éléments de premier niveau de /tmp (B1 bis). Tout se décide ici, dans le main : le renderer ne fait que
// proposer des noms de la dernière liste ; le main fait confirmer, puis revérifie chaque élément juste avant de le supprimer.
//
// Suppression sûre face à un échange de dossier par un lien pendant la récursion :
//  1. une quarantaine 0700 est créée dans la racine et aussitôt ouverte (O_DIRECTORY|O_NOFOLLOW, fstat : à nous, 0700) ;
//     toute la suite passe par ce descripteur (/proc/self/fd/<fd>/<nom>) et jamais par son chemin : la remplacer par un
//     lien n'a aucun effet ;
//  2. l'élément y est déplacé (rename, atomique), puis tenu par un descripteur O_PATH|O_NOFOLLOW dont le fstat doit
//     donner l'inode vérifié (ino, dev, uid, type) ; sinon rien n'est supprimé et l'objet reste à l'écart ;
//  3. la récursion est faite par GNU rm (`rm -r --one-file-system -- /proc/self/fd/3/<nom>`, la quarantaine passée en
//     fd 3), qui travaille par descripteurs (openat/unlinkat, dev/ino vérifiés à chaque descente) : un sous-dossier
//     remplacé par un lien n'est jamais suivi, aucun point de montage n'est franchi. Aucune récursion en JavaScript ;
//  4. succès seulement si l'inode tenu n'a plus de lien (nlink) : si un autre objet a été glissé à sa place dans la
//     quarantaine, l'élément choisi a survécu et rien n'est annoncé supprimé.
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as FS, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, type BigIntStats } from 'node:fs';
import * as nodeFsp from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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
  open(p: string, flags: number): Promise<CleanHandle>;
}
export interface CleanHandle {
  fd: number;
  stat(o: { bigint: true }): Promise<BigIntStats>;
  close(): Promise<void>;
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
  /** Système de fichiers de la lecture de /proc (procfs ne bloque pas) ; défaut : `fs`. */
  procFs?: CleanFs;
  /** « Vider la quarantaine » : délai de chaque appel au système de fichiers (défaut 5 s). */
  fsTimeoutMs?: number;
  /** « Vider la quarantaine » : durée totale (défaut 60 s), vérifiée avant chaque entrée. */
  quarantineBudgetMs?: number;
  /** « Vider la quarantaine » : entrées traitées au plus par passe (défaut 1 000). */
  quarantineMaxEntries?: number;
  now?: () => number;
}

const PROC_BUDGET_MS = 3_000;
const DELETE_BUDGET_MS = 20_000;
const RM_TIMEOUT_MS = 30_000;
const FS_TIMEOUT_MS = 5_000;
const QUARANTINE_BUDGET_MS = 60_000;
const QUARANTINE_MAX_ENTRIES = 1_000;
const INVENTORY_MAX_STATS = 200_000;
const INVENTORY_BUDGET_MS = 5_000;
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
  const [mounts, users] = await Promise.all([readMounts(real, o), scanTmpUsers(real, { ...o, fs: o.procFs ?? fs })]);
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

/**
 * `rm -r --one-file-system -- /proc/self/fd/3/<nom>`, sans shell, la quarantaine passée en fd 3 ; délai puis SIGKILL.
 * Se règle toujours : après le délai, la promesse rend la main au plus tard 1 s plus tard (le verrou de suppression est
 * alors relâché) même si rm reste en sommeil ininterruptible (FUSE figé). Ce rm continue alors seul, sans danger : il
 * travaille par descripteurs, dans la quarantaine ouverte.
 */
function runRm(rmPath: string, quarantineFd: number, name: string, timeoutMs: number): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let done = false;
    let stderr = '';
    const finish = (r: { ok: true } | { ok: false; error: string }) => {
      if (done) return;
      done = true;
      clearTimeout(kill);
      clearTimeout(guard);
      resolve(r);
    };
    const timeoutError = { ok: false as const, error: 'délai dépassé (montage figé ?)' };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(rmPath, ['-r', '--one-file-system', '--', `/proc/self/fd/3/${name}`], {
        stdio: ['ignore', 'ignore', 'pipe', quarantineFd],
        env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' },
      });
    } catch (e) {
      resolve({ ok: false, error: String((e as Error).message) });
      return;
    }
    const kill = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const guard = setTimeout(() => finish(timeoutError), timeoutMs + 1_000);
    child.stderr!.on('data', (b) => {
      if (stderr.length < 4096) stderr += String(b);
    });
    child.on('error', (e) => finish({ ok: false, error: String(e.message) }));
    child.on('close', (codeN, signal) => {
      if (codeN === 0) return finish({ ok: true });
      if (signal === 'SIGKILL') return finish(timeoutError);
      const line = stderr.trim().split('\n')[0] || `code ${codeN}`;
      finish({ ok: false, error: line.replace(/^\S*rm: /, '').slice(0, 200) });
    });
  });
}

const O_PATH = 0o10000000; // Linux : désigne l'inode sans l'ouvrir (fstat seulement), même un lien ou un fichier 000

interface Quarantine {
  path: string;
  fd: number;
  ino: bigint;
  /** Chemin d'un nom dans la quarantaine, par son descripteur (indépendant de son chemin). */
  at(name: string): string;
  close(): Promise<void>;
}

/**
 * Objets mis à l'écart après un échange (jamais choisis par l'utilisateur), par inode de quarantaine et nom d'entrée.
 * Gardés par le main, jamais dans la quarantaine (un processus du même uid pourrait y planter un lien) : en mémoire, et
 * dans le dossier de données de l'app (0600, écriture atomique) pour survivre à un redémarrage.
 */
export interface SetAsideStore {
  has(quarantineIno: string, name: string): boolean;
  add(quarantineIno: string, name: string): void;
  /** Oublie une entrée, ou toute la quarantaine si `name` est absent. */
  forget(quarantineIno: string, name?: string): void;
  /** Oublie les quarantaines qui n'existent plus (inodes absents de `alive`). */
  prune(alive: ReadonlySet<string>): void;
}

export function createSetAsideStore(path?: string): SetAsideStore {
  let items: { quarantine: string; name: string }[] = [];
  if (path) {
    try {
      const v = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (Array.isArray(v))
        items = v.filter((x): x is { quarantine: string; name: string } => typeof x?.quarantine === 'string' && /^\d{1,20}$/.test(x.quarantine) && typeof x?.name === 'string').map((x) => ({ quarantine: x.quarantine, name: x.name }));
    } catch {
      // absent ou illisible : liste vide
    }
  }
  const save = () => {
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      writeFileSync(tmp, JSON.stringify(items), { mode: 0o600, flag: 'wx' });
      renameSync(tmp, path);
    } catch (e) {
      console.error('proc-watch : liste des objets mis à l’écart non enregistrée :', e);
    }
  };
  return {
    has: (q, n) => items.some((x) => x.quarantine === q && x.name === n),
    add: (q, n) => {
      if (items.some((x) => x.quarantine === q && x.name === n)) return;
      items.push({ quarantine: q, name: n });
      save();
    },
    prune: (alive) => {
      const next = items.filter((x) => alive.has(x.quarantine));
      if (next.length === items.length) return;
      items = next;
      save();
    },
    forget: (q, n) => {
      const next = items.filter((x) => !(x.quarantine === q && (n === undefined || x.name === n)));
      if (next.length === items.length) return;
      items = next;
      save();
    },
  };
}

/** Ouvre un dossier de quarantaine (O_DIRECTORY|O_NOFOLLOW) et vérifie qu'il est à nous, en 0700, sur le système de fichiers de la racine. */
async function openQuarantine(fs: CleanFs, path: string, uid: number, rootDev: bigint): Promise<Quarantine> {
  const h = await fs.open(path, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW);
  try {
    const st = await h.stat({ bigint: true });
    if (!st.isDirectory() || st.uid !== B(uid) || (Number(st.mode) & 0o7777) !== 0o700) throw new Error('quarantaine inattendue (propriétaire ou droits)');
    if (st.dev !== rootDev) throw new Error('quarantaine sur un autre système de fichiers');
    return {
      path,
      fd: h.fd,
      ino: st.ino,
      at: (name) => `/proc/self/fd/${h.fd}/${name}`,
      close: async () => {
        // retirée seulement si c'est toujours elle (même inode) et vide ; sinon laissée, signalée dans la liste
        const now = await fs.lstat(path, { bigint: true }).catch(() => null);
        if (now && now.isDirectory() && now.ino === st.ino) await fs.rmdir(path).catch(() => {});
        await h.close().catch(() => {});
      },
    };
  } catch (e) {
    await h.close().catch(() => {});
    throw e;
  }
}

/**
 * Supprime `name` dans la quarantaine `q`, avec GNU rm par le descripteur de la quarantaine. `expect` : identité exigée
 * (sinon rien n'est supprimé). Succès seulement si l'inode tenu a bien perdu son nom (nlink).
 */
async function removeQuarantined(
  fs: CleanFs,
  rmPath: string,
  timeoutMs: number,
  q: Quarantine,
  name: string,
  expect: ((st: BigIntStats) => boolean) | null,
  onSetAside?: (name: string) => void,
): Promise<{ ok: true } | { ok: false; reason: string; partial?: boolean }> {
  const held = await fs.open(q.at(name), O_PATH | FS.O_NOFOLLOW).catch(() => null);
  if (!held) return { ok: false, reason: `disparu de la quarantaine ${q.path}` };
  try {
    const before = await held.stat({ bigint: true });
    if (expect && !expect(before)) {
      // noté par le main (jamais dans la quarantaine) pour « Vider la quarantaine » : cet objet n'a jamais été choisi
      onSetAside?.(name);
      return { ok: false, reason: `un autre élément a pris sa place ; il a été mis à l’écart dans ${q.path} (non supprimé)` };
    }
    const rm = await runRm(rmPath, q.fd, name, timeoutMs);
    const after = await held.stat({ bigint: true }).catch(() => null);
    const gone = after !== null && (before.isDirectory() ? after.nlink === 0n : after.nlink < before.nlink);
    if (rm.ok && gone) return { ok: true };
    if (rm.ok) return { ok: false, reason: `non supprimé : remplacé dans la quarantaine pendant la suppression (un autre objet a pu être supprimé à sa place) ; il est hors de ${q.path}`, partial: true };
    return { ok: false, reason: `échec : ${rm.error} ; le reste est dans ${q.path}`, partial: true };
  } finally {
    await held.close().catch(() => {});
  }
}

/** Quarantaines restées (suppression interrompue) au premier niveau ; éligibles au vidage : dossier à nous, 0700. */
async function leftoverQuarantines(c: Ctx): Promise<{ name: string; eligible: boolean; ino: bigint | null }[]> {
  const names = (await c.fs.readdir(c.root).catch(() => [] as string[])).filter((n) => n.startsWith(TRASH_PREFIX)).sort();
  const out: { name: string; eligible: boolean; ino: bigint | null }[] = [];
  for (const name of names) {
    const p = join(c.root, name);
    if (c.mounts === null || c.mounts.has(p)) {
      out.push({ name, eligible: false, ino: null });
      continue;
    }
    const st = await c.fs.lstat(p, { bigint: true }).catch(() => null);
    const ok = !!st && st.isDirectory() && st.uid === B(c.uid) && (Number(st.mode) & 0o7777) === 0o700 && st.dev === c.rootDev && c.uid !== 0;
    out.push({ name, eligible: ok, ino: st ? st.ino : null });
  }
  return out;
}

/** Rejette après `ms` ; une valeur arrivée trop tard est passée à `late` (ex. fermer un descripteur). */
function within<T>(p: Promise<T>, ms: number, late?: (v: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let over = false;
    const t = setTimeout(() => {
      over = true;
      reject(new Error('délai dépassé (système de fichiers bloqué ?)'));
    }, ms);
    p.then(
      (v) => {
        if (over) late?.(v);
        else {
          clearTimeout(t);
          resolve(v);
        }
      },
      (e) => {
        if (!over) {
          clearTimeout(t);
          reject(e);
        }
      },
    );
  });
}

/** File d'au plus `slots` appels au système de fichiers en vol ; un appel figé garde sa place jusqu'à sa vraie fin. */
export interface FsSlots {
  run<T>(f: () => Promise<T>): { promise: Promise<T>; cancel(): void };
  inFlight(): number;
}
export function createFsSlots(slots = 2): FsSlots {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    while (active < slots && queue.length) queue.shift()!();
  };
  return {
    inFlight: () => active,
    run<T>(f: () => Promise<T>) {
      let cancelled = false;
      const promise = new Promise<T>((resolve, reject) => {
        const start = () => {
          if (cancelled) return; // délai passé dans la file : jamais lancé
          active++;
          f()
            .then(resolve, reject)
            .finally(() => {
              active--;
              next();
            });
        };
        if (active < slots) start();
        else queue.push(start);
      });
      return { promise, cancel: () => void (cancelled = true) };
    },
  };
}

/**
 * Système de fichiers de « Vider la quarantaine » : chaque appel est borné par `ms`, et au plus `slots` appels sont en
 * vol à la fois (file partagée par le nettoyeur). Un délai n'annule pas l'appel : il continue dans le pool de libuv
 * (4 fils par défaut) en gardant sa place dans la file ; des montages figés n'occupent donc jamais plus de 2 fils.
 * Un descripteur ouvert après le délai est refermé.
 */
function timedFs(fs: CleanFs, ms: number, slots: FsSlots): CleanFs {
  const t = <T,>(f: () => Promise<T>, late?: (v: T) => void): Promise<T> => {
    const job = slots.run(f);
    return within(job.promise, ms, late).catch((e) => {
      job.cancel();
      throw e;
    });
  };
  const handle = (h: CleanHandle): CleanHandle => ({
    fd: h.fd,
    stat: (o) => t(() => h.stat(o)),
    close: () => t(() => h.close()).catch(() => {}),
  });
  return {
    lstat: (p, o) => t(() => fs.lstat(p, o)),
    realpath: (p) => t(() => fs.realpath(p)),
    readdir: (p) => t(() => fs.readdir(p)),
    readlink: (p) => t(() => fs.readlink(p)),
    readFile: (p, e) => t(() => fs.readFile(p, e)),
    rename: (a, b) => t(() => fs.rename(a, b)),
    mkdtemp: (p) => t(() => fs.mkdtemp(p)),
    rmdir: (p) => t(() => fs.rmdir(p)),
    open: (p, f) => t(() => fs.open(p, f), (h) => void h.close().catch(() => {})).then(handle),
  };
}

/** Budget partagé de l'inventaire : nombre de lstat et échéance (horloge réelle). */
interface InventoryBudget {
  statsLeft: number;
  deadline: number;
}

/** Place occupée sous `path` (sans suivre aucun lien), dans le budget partagé ; « au moins » si le budget est épuisé. */
async function sizeOf(fs: CleanFs, path: string, st: BigIntStats, b: InventoryBudget): Promise<{ kb: number; atLeast: boolean }> {
  let kb = (Number(st.blocks) * 512) / 1024;
  if (!st.isDirectory()) return { kb: Math.round(kb), atLeast: false };
  const stack = [path];
  const out = () => b.statsLeft <= 0 || Date.now() > b.deadline;
  while (stack.length) {
    if (out()) return { kb: Math.round(kb), atLeast: true };
    const d = stack.pop()!;
    const names = await fs.readdir(d).catch(() => [] as string[]);
    for (const name of names) {
      if (out()) return { kb: Math.round(kb), atLeast: true };
      b.statsLeft--;
      const c = await fs.lstat(`${d}/${name}`, { bigint: true }).catch(() => null);
      if (!c) continue;
      kb += (Number(c.blocks) * 512) / 1024;
      if (c.isDirectory() && c.dev === st.dev) stack.push(`${d}/${name}`);
    }
  }
  return { kb: Math.round(kb), atLeast: false };
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
  /** Objets mis à l'écart après un échange (défaut : en mémoire seulement ; le main la garde dans son dossier de données). */
  setAside?: SetAsideStore;
  /** Inventaire de « Vider la quarantaine » : lstat au plus (défaut 200 000) et durée (défaut 5 s), pour toutes les entrées. */
  inventoryMaxStats?: number;
  inventoryBudgetMs?: number;
}

export interface TmpCleaner {
  list(): Promise<TmpListing>;
  delete(items: unknown): Promise<TmpDeleteOutcome>;
  /** Vide les quarantaines restées (suppressions interrompues), après confirmation native. */
  emptyQuarantine(): Promise<TmpDeleteOutcome>;
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
  // seule une détection réussie est gardée : un --version lent (pression mémoire) ne désactive pas tout jusqu'au redémarrage
  let rmOk = false;
  const disabled = async (): Promise<string | null> => {
    if (rmOk) return null;
    const r = await checkGnuRm(rmPath);
    if (r === null) rmOk = true;
    return r;
  };
  let allowed = new Map<string, Allowed>();
  let busy = false;
  const setAside = o.setAside ?? createSetAsideStore();
  const fsSlots = createFsSlots(2); // partagé par toutes les passes de « Vider la quarantaine »

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
    const leftovers = await leftoverQuarantines(c);
    // liste du main : les quarantaines disparues sont oubliées (seulement si les montages sont lisibles : inventaire complet)
    if (c.mounts !== null) setAside.prune(new Set(leftovers.filter((x) => x.ino !== null).map((x) => String(x.ino))));
    const quarantines = leftovers.map(({ name, eligible }) => ({ name, eligible }));
    return { root, entries, truncated: usage.truncated, uninspectable: c.users.uninspectable, disabled: off, quarantines };
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
    let q: Quarantine | null = null;
    const rmTimeout = o.rmTimeoutMs ?? RM_TIMEOUT_MS;
    try {
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
          // 0700, même système de fichiers ; ouverte aussitôt : la suite ne passe plus par son chemin
          q ??= await openQuarantine(fs, await fs.mkdtemp(join(c.root, TRASH_PREFIX)), c.uid, c.rootDev);
        } catch (e) {
          refuse(item.name, `échec de la quarantaine : ${code(e) ?? (e as Error).message}`);
          continue;
        }
        try {
          await fs.rename(p, q.at(item.name));
        } catch (e) {
          refuse(item.name, `échec du déplacement : ${code(e) ?? 'erreur'}`);
          continue;
        }
        const same = (m: BigIntStats) => m.ino === a.ino && m.dev === a.dev && m.uid === a.uid && kindOf(m) === a.kind;
        const qq = q;
        const res = await removeQuarantined(fs, rmPath, rmTimeout, q, item.name, same, (n) => setAside.add(String(qq.ino), n));
        if (res.ok) {
          results.set(item.name, { name: item.name, ok: true });
          freedKB += a.sizeKB;
        } else {
          if (res.partial) partial = true;
          refuse(item.name, res.reason);
        }
      }
    } finally {
      await q?.close(); // retirée si vide et toujours elle ; sinon laissée et signalée (« Vider la quarantaine »)
    }
    return { results: ordered(), freedKB, ...(partial ? { partial } : {}) };
  }

  /**
   * « Vider la quarantaine » : quarantaines restées éligibles. Chaque quarantaine est ouverte (descripteur, à nous, 0700,
   * même système de fichiers), ses entrées de premier niveau sont listées avec leur taille pour la confirmation native
   * (objets mis à l'écart après un échange signalés), puis supprimées une à une par la même voie que la suppression.
   * Appels au système de fichiers bornés (fsTimeoutMs), durée totale bornée, nombre d'entrées plafonné.
   */
  async function emptyQuarantine(): Promise<TmpDeleteOutcome> {
    if (busy) throw new Error('Une suppression est déjà en cours');
    busy = true;
    const tfs = timedFs(fs, o.fsTimeoutMs ?? FS_TIMEOUT_MS, fsSlots);
    // /proc et mountinfo : lus directement (procfs ne bloque pas) ; tout le reste passe par tfs
    const ot: CleanOptions = { ...o, fs: tfs, procFs: fs };
    const budget = o.quarantineBudgetMs ?? QUARANTINE_BUDGET_MS;
    const maxEntries = o.quarantineMaxEntries ?? QUARANTINE_MAX_ENTRIES;
    const inv: InventoryBudget = { statsLeft: o.inventoryMaxStats ?? INVENTORY_MAX_STATS, deadline: Date.now() + (o.inventoryBudgetMs ?? INVENTORY_BUDGET_MS) };
    type Rec = {
      name: string;
      q: Quarantine | null;
      error: string | null;
      entries: { name: string; ino: bigint; kind: TmpEntry['kind']; sizeKB: number; atLeast: boolean; setAside: boolean }[];
      more: number;
      /** Entrées non inventoriées : budget de l'inventaire épuisé (jamais confirmées, donc jamais supprimées). */
      unlisted: number;
    };
    const opened: Rec[] = [];
    try {
      const off = await disabled();
      if (off) throw new Error(off);
      const c0 = await context(root, ot);
      if (c0.mounts === null) throw new Error('impossible de vérifier (points de montage illisibles)');
      const found = (await leftoverQuarantines(c0)).filter((x) => x.eligible);
      if (!found.length) return { results: [], freedKB: 0 };
      // 1) ouverture et inventaire (pour la confirmation), dans leur propre budget
      let left = maxEntries;
      for (const x of found) {
        const rec: Rec = { name: x.name, q: null, error: null, entries: [], more: 0, unlisted: 0 };
        opened.push(rec);
        const p = join(c0.root, x.name);
        if ([...c0.mounts].some((m) => m === p || m.startsWith(`${p}/`))) {
          rec.error = 'contient un point de montage';
          continue;
        }
        const u = c0.users.complete ? c0.users.users.get(x.name) : null;
        if (!c0.users.complete || u) {
          rec.error = u ? usedBy(u) : 'impossible de vérifier';
          continue;
        }
        try {
          rec.q = await openQuarantine(tfs, p, c0.uid, c0.rootDev);
          if (rec.q.ino !== x.ino) throw new Error('a changé depuis l’affichage');
          const qino = String(rec.q.ino);
          const names = (await tfs.readdir(`/proc/self/fd/${rec.q.fd}`)).sort();
          const take = names.slice(0, Math.max(0, left));
          rec.more = names.length - take.length;
          left -= take.length;
          for (const n of take) {
            // le lstat de premier niveau compte aussi dans le budget partagé de l'inventaire
            if (inv.statsLeft <= 0 || Date.now() > inv.deadline) {
              rec.unlisted++;
              continue;
            }
            inv.statsLeft--;
            const st = await tfs.lstat(rec.q.at(n), { bigint: true }).catch(() => null);
            if (!st) continue;
            const size = await sizeOf(tfs, rec.q.at(n), st, inv).catch(() => ({ kb: 0, atLeast: true }));
            rec.entries.push({ name: n, ino: st.ino, kind: kindOf(st), sizeKB: size.kb, atLeast: size.atLeast, setAside: setAside.has(qino, n) });
          }
        } catch (e) {
          rec.error = `refusée : ${code(e) ?? (e as Error).message}`;
        }
      }
      const usable = opened.filter((r) => r.q && !r.error);
      const results: TmpDeleteResult[] = opened.filter((r) => r.error).map((r) => ({ name: r.name, ok: false, reason: r.error! }));
      if (!usable.length) return { results, freedKB: 0 };
      // 2) confirmation native : chaque entrée, sa taille, et les objets jamais choisis
      const kbOf = (r: Rec) => r.entries.reduce((t, e) => t + e.sizeKB, 0);
      const ok = await o.confirm({
        purpose: 'quarantine',
        root: c0.root,
        items: usable.map((r) => ({ name: r.name, kind: 'dir' as const, sizeKB: kbOf(r), recent: false })),
        totalKB: usable.reduce((t, r) => t + kbOf(r), 0),
        uninspectable: c0.users.uninspectable,
        quarantines: usable.map((r) => ({ name: r.name, entries: r.entries.map(({ name, kind, sizeKB, atLeast, setAside: sa }) => ({ name, kind, sizeKB, atLeast, setAside: sa })), more: r.more + r.unlisted })),
      });
      if (!ok) return { results: [...results, ...usable.map((r) => ({ name: r.name, ok: false, reason: 'annulé' }))], freedKB: 0, cancelled: true };
      // 3) après la confirmation (la boîte a pu rester ouverte longtemps) : montages et usage relus, budget démarré
      const mountsNow = await readMounts(c0.root, o);
      const start = now();
      let partial = false;
      let freedKB = 0;
      const rmTimeout = o.rmTimeoutMs ?? RM_TIMEOUT_MS;
      for (const r of usable) {
        const q = r.q!;
        const qino = String(q.ino);
        // chemin réel de l'inode ouvert ; s'il ne correspond plus à q.path (renommée, remplacée), rien n'est supprimé
        const realQ = await fs.readlink(`/proc/self/fd/${q.fd}`).catch(() => null);
        const atPath = await tfs.lstat(q.path, { bigint: true }).catch(() => null);
        if (!realQ || realQ !== q.path || !atPath || atPath.ino !== q.ino || !atPath.isDirectory()) {
          partial = true;
          results.push({ name: r.name, ok: false, reason: 'a changé depuis l’affichage (quarantaine déplacée ou remplacée) : rien supprimé' });
          continue;
        }
        const users = await scanTmpUsers(realQ, { ...o, fs });
        const errors: string[] = [];
        let late = 0;
        for (const e of r.entries) {
          const ep = join(q.path, e.name);
          const why =
            mountsNow === null
              ? 'impossible de vérifier (points de montage illisibles)'
              : mountsNow.has(ep)
                ? 'point de montage'
                : [...mountsNow].some((m) => m.startsWith(`${ep}/`))
                  ? 'contient un point de montage'
                  : !users.complete
                    ? 'impossible de vérifier'
                    : users.users.has(e.name)
                      ? usedBy(users.users.get(e.name)!)
                      : null;
          if (why) {
            errors.push(`${e.name} : ${why}`);
            continue;
          }
          const spent = now() - start;
          if (spent > budget) {
            late++;
            continue;
          }
          const res = await removeQuarantined(tfs, rmPath, Math.max(1_000, Math.min(rmTimeout, budget - spent)), q, e.name, (st) => st.ino === e.ino);
          if (res.ok) {
            freedKB += e.sizeKB;
            setAside.forget(qino, e.name);
          } else errors.push(`${e.name} : ${res.reason}`);
        }
        if (late) errors.push(`temps écoulé (${late} entrée${late > 1 ? 's' : ''} non traitée${late > 1 ? 's' : ''})`);
        if (r.unlisted) errors.push(`${r.unlisted} entrée${r.unlisted > 1 ? 's' : ''} non inventoriée${r.unlisted > 1 ? 's' : ''} (budget de l’inventaire)`);
        if (r.more) errors.push(`${r.more} entrée${r.more > 1 ? 's' : ''} non traitée${r.more > 1 ? 's' : ''} (plafond de ${maxEntries})`);
        if (errors.length) {
          partial = true;
          results.push({ name: r.name, ok: false, reason: errors.join(' ; ') });
        } else {
          results.push({ name: r.name, ok: true });
          setAside.forget(qino);
        }
      }
      return { results, freedKB, ...(partial ? { partial } : {}) };
    } finally {
      for (const r of opened) await r.q?.close().catch(() => {});
      busy = false;
    }
  }

  return { list, delete: del, emptyQuarantine };
}

/** Texte de la confirmation native (titre et détail), noms échappés. */
export function confirmText(s: TmpConfirmSummary, formatKB: (kb: number) => string): { message: string; detail: string } {
  if (s.purpose === 'quarantine') {
    const blocks = (s.quarantines ?? s.items.map((i) => ({ name: i.name, entries: [], more: 0 }))).map((q) => {
      const head = `${s.root}/${displayName(q.name).text}/`;
      const lines = q.entries.map((e) => {
        const d = displayName(e.name);
        const suffix = e.kind === 'link' ? ' (le lien seul)' : e.kind === 'dir' ? '/' : '';
        return `   ${d.escaped ? '⚠ ' : ''}${d.text}${suffix} — ${e.atLeast ? 'au moins ' : ''}${formatKB(e.sizeKB)}${e.setAside ? ' — ⚠ mis à l’écart après un échange (jamais choisi)' : ''}`;
      });
      if (q.more) lines.push(`   … et ${q.more} autre${q.more > 1 ? 's' : ''} (non traitée${q.more > 1 ? 's' : ''} cette fois : plafond)`);
      return [head, ...lines].join('\n');
    });
    const parts = [blocks.join('\n\n'), `Total : ${formatKB(s.totalKB)}`, 'Restes de suppressions interrompues : ces entrées seront supprimées.'];
    if (s.quarantines?.some((q) => q.entries.some((e) => e.setAside)))
      parts.push('⚠ Les objets « mis à l’écart » ont pris la place d’un élément pendant une suppression : ils n’ont jamais été choisis. Ils seront supprimés aussi.');
    parts.push("C'est définitif, la corbeille ne libérerait pas la RAM (elle est sur disque).");
    return { message: `Vider ${s.items.length > 1 ? `les ${s.items.length} quarantaines` : 'la quarantaine'} de proc-watch ?`, detail: parts.join('\n\n') };
  }
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
