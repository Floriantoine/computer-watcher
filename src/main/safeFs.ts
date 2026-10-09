// Fichiers de proc-watch sous HOME / XDG, par descripteur de dossier : chaque dossier sous la racine est ouvert avec
// O_DIRECTORY|O_NOFOLLOW (un dossier remplacé par un lien est refusé), et les fichiers sont créés, renommés ou supprimés
// relativement à ce descripteur (`/proc/self/fd/<fd>/<nom>`, l'équivalent de openat). La racine elle-même (HOME,
// XDG_CONFIG_HOME, XDG_DATA_HOME) peut être un lien : c'est le choix de l'utilisateur.
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, constants as C, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, promises as fsp, readdirSync, readFileSync, renameSync,
  rmdirSync, unlinkSync, writeSync,
} from 'node:fs';
import { sep } from 'node:path';

const DIR = C.O_RDONLY | C.O_DIRECTORY;
const DIR_NOFOLLOW = DIR | C.O_NOFOLLOW;
export const fdPath = (dfd: number, name: string) => `/proc/self/fd/${dfd}/${name}`;
const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code;

export interface Placed { root: string; dirs: string[]; name: string }

/** Racine (la plus longue) sous laquelle se trouve `path`, dossiers intermédiaires et nom. Hors racine ou « .. » : erreur. */
export function placeUnder(roots: readonly string[], path: string): Placed {
  const root = [...roots].filter((r) => path.startsWith(r.endsWith(sep) ? r : r + sep)).sort((a, b) => b.length - a.length)[0];
  if (!root) throw new Error(`${path} : hors des dossiers de proc-watch`);
  const parts = path.slice(root.length).split(sep).filter(Boolean);
  if (!parts.length || parts.some((p) => p === '.' || p === '..')) throw new Error(`${path} : chemin refusé`);
  return { root, dirs: parts.slice(0, -1), name: parts.at(-1)! };
}

const linkError = (path: string) => new Error(`${path} : lien symbolique, refusé (jamais suivi)`);

/**
 * Descripteur du dossier parent : racine ouverte normalement, puis chaque composant en O_NOFOLLOW. `create` : dossiers
 * manquants créés (0755). Absent sans `create` : null.
 */
export function openParent(roots: readonly string[], path: string, create: boolean): { fd: number; name: string } | null {
  const p = placeUnder(roots, path);
  let fd: number;
  try {
    fd = openSync(p.root, DIR);
  } catch (e) {
    if (code(e) !== 'ENOENT') throw e;
    if (!create) return null;
    mkdirSync(p.root, { recursive: true });
    fd = openSync(p.root, DIR);
  }
  let shown = p.root;
  for (const d of p.dirs) {
    shown += sep + d;
    let next: number | null = null;
    try {
      next = openSync(fdPath(fd, d), DIR_NOFOLLOW);
    } catch (e) {
      const c = code(e);
      if (c === 'ENOENT' && create) {
        try {
          mkdirSync(fdPath(fd, d), 0o755);
        } catch (e2) {
          if (code(e2) !== 'EEXIST') {
            closeSync(fd);
            throw e2;
          }
        }
        try {
          next = openSync(fdPath(fd, d), DIR_NOFOLLOW);
        } catch (e3) {
          closeSync(fd);
          throw code(e3) === 'ELOOP' ? linkError(shown) : e3;
        }
      } else {
        closeSync(fd);
        if (c === 'ENOENT') return null;
        if (c === 'ELOOP') throw linkError(shown);
        if (c === 'ENOTDIR') {
          let isLink = false;
          try {
            isLink = lstatSync(shown).isSymbolicLink();
          } catch {
            // disparu
          }
          throw isLink ? linkError(shown) : new Error(`${shown} : pas un dossier, refusé`);
        }
        throw e;
      }
    }
    closeSync(fd);
    fd = next;
  }
  return { fd, name: p.name };
}

function fsyncDir(fd: number): void {
  try {
    fsyncSync(fd);
  } catch {
    // certains systèmes de fichiers refusent fsync sur un dossier
  }
}

const tmpFor = (name: string) => `.${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;

/** Supprime le temporaire seulement si c'est bien celui que nous avons créé (même inode). */
function dropTmp(dfd: number, tmp: string, ino: number | null): void {
  if (ino === null) return;
  try {
    if (lstatSync(fdPath(dfd, tmp)).ino === ino) unlinkSync(fdPath(dfd, tmp));
  } catch {
    // déjà parti
  }
}

/** Contenu d'un fichier ordinaire, sans jamais suivre de lien (dossiers ni dernier élément) ; absent, lien ou autre → null. */
export function readFileSafe(roots: readonly string[], path: string): string | null {
  let parent;
  try {
    parent = openParent(roots, path, false);
  } catch {
    return null;
  }
  if (!parent) return null;
  let fd: number | null = null;
  try {
    fd = openSync(fdPath(parent.fd, parent.name), C.O_RDONLY | C.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) return null;
    return readFileSync(fd, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
    closeSync(parent.fd);
  }
}

export interface WriteOptions {
  /** Destination existante (contenu si fichier ordinaire, sinon null) → message de refus, ou null pour écrire. */
  guard?: (current: string | null) => string | null;
  /** Nom du temporaire (tests). */
  tmpName?: string;
}

/** Écriture atomique : temporaire O_EXCL|O_NOFOLLOW, fchmod, fsync, rename relatif au dossier, fsync du dossier. */
export function writeFileSafe(roots: readonly string[], path: string, data: string | Buffer, mode = 0o644, o: WriteOptions = {}): void {
  const parent = openParent(roots, path, true)!;
  const { fd: dfd, name } = parent;
  const tmp = o.tmpName ?? tmpFor(name);
  let ino: number | null = null;
  try {
    if (o.guard) {
      let current: string | null = null;
      let exists = false;
      try {
        const st = lstatSync(fdPath(dfd, name));
        exists = true;
        if (st.isFile()) current = readFileSafe(roots, path);
      } catch {
        // absent
      }
      const refusal = exists ? o.guard(current) : null;
      if (refusal) throw new Error(refusal);
    }
    const fd = openSync(fdPath(dfd, tmp), C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, mode);
    try {
      ino = fstatSync(fd).ino;
      const buf = typeof data === 'string' ? Buffer.from(data) : data;
      let off = 0;
      while (off < buf.length) off += writeSync(fd, buf, off);
      fchmodSync(fd, mode);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(fdPath(dfd, tmp), fdPath(dfd, name));
    ino = null;
    fsyncDir(dfd);
  } catch (e) {
    dropTmp(dfd, tmp, ino);
    throw e;
  } finally {
    closeSync(dfd);
  }
}

/** SHA-256 d'un fichier ordinaire, sans suivre de lien ; renvoie aussi son inode (pour revérifier avant suppression). */
export async function hashNoFollow(path: string): Promise<{ sha256: string; ino: number; size: number }> {
  const fh = await fsp.open(path, C.O_RDONLY | C.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error(`${path} : pas un fichier ordinaire`);
    const h = createHash('sha256');
    const buf = Buffer.alloc(1 << 20);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (!bytesRead) break;
      h.update(buf.subarray(0, bytesRead));
    }
    return { sha256: h.digest('hex'), ino: st.ino, size: st.size };
  } finally {
    await fh.close();
  }
}

/**
 * Copie atomique (AppImage) : même schéma que writeFileSafe, sans bloquer le main ; la copie est relue après le rename et
 * doit avoir le même SHA-256 que les octets lus. Renvoie le SHA-256 et si la copie est exécutable (montage noexec…).
 */
export async function copyFileSafe(roots: readonly string[], src: string, dest: string, mode: number): Promise<{ sha256: string; executable: boolean }> {
  const parent = openParent(roots, dest, true)!;
  const { fd: dfd, name } = parent;
  const tmp = tmpFor(name);
  let ino: number | null = null;
  try {
    const h = createHash('sha256');
    const input = await fsp.open(src, C.O_RDONLY | C.O_NOFOLLOW);
    try {
      if (!(await input.stat()).isFile()) throw new Error(`${src} : pas un fichier ordinaire`);
      const out = await fsp.open(fdPath(dfd, tmp), C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, mode);
      try {
        ino = (await out.stat()).ino;
        const buf = Buffer.alloc(1 << 20);
        for (;;) {
          const { bytesRead } = await input.read(buf, 0, buf.length, null);
          if (!bytesRead) break;
          h.update(buf.subarray(0, bytesRead));
          let off = 0;
          while (off < bytesRead) off += (await out.write(buf, off, bytesRead - off)).bytesWritten;
        }
        await out.chmod(mode); // fchmod
        await out.sync();
      } finally {
        await out.close();
      }
    } finally {
      await input.close();
    }
    const sha256 = h.digest('hex');
    renameSync(fdPath(dfd, tmp), fdPath(dfd, name));
    ino = null;
    fsyncDir(dfd);
    const check = await hashNoFollow(fdPath(dfd, name));
    if (check.sha256 !== sha256) throw new Error(`${dest} : copie différente de l’original après écriture`);
    let executable = true;
    try {
      await fsp.access(fdPath(dfd, name), C.X_OK);
    } catch {
      executable = false;
    }
    return { sha256, executable };
  } catch (e) {
    dropTmp(dfd, tmp, ino);
    throw e;
  } finally {
    closeSync(dfd);
  }
}

/** fchmod d'un fichier ordinaire ouvert en O_NOFOLLOW (jamais la cible d'un lien posé entre-temps). */
export function chmodSafe(roots: readonly string[], path: string, mode: number): void {
  const parent = openParent(roots, path, false);
  if (!parent) throw new Error(`${path} : introuvable`);
  try {
    const fd = openSync(fdPath(parent.fd, parent.name), C.O_RDONLY | C.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isFile()) throw new Error(`${path} : pas un fichier ordinaire`);
      fchmodSync(fd, mode);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    throw code(e) === 'ELOOP' ? linkError(path) : e;
  } finally {
    closeSync(parent.fd);
  }
}

/** Supprime un fichier ordinaire relativement à son dossier (ouvert sans suivre) ; lien ou autre type : refusé. */
export function removeFileSafe(roots: readonly string[], path: string): 'removed' | 'absent' {
  const parent = openParent(roots, path, false);
  if (!parent) return 'absent';
  try {
    let st;
    try {
      st = lstatSync(fdPath(parent.fd, parent.name));
    } catch (e) {
      if (code(e) === 'ENOENT') return 'absent';
      throw e;
    }
    if (st.isSymbolicLink()) throw linkError(path);
    if (!st.isFile()) throw new Error(`${path} : pas un fichier ordinaire, laissé en place`);
    unlinkSync(fdPath(parent.fd, parent.name));
    return 'removed';
  } finally {
    closeSync(parent.fd);
  }
}

/** Retire un dossier s'il est vide (rmdir relatif au parent) ; lien : refusé. */
export function removeDirIfEmptySafe(roots: readonly string[], path: string): 'removed' | 'absent' | 'not-empty' {
  const parent = openParent(roots, path, false);
  if (!parent) return 'absent';
  try {
    let st;
    try {
      st = lstatSync(fdPath(parent.fd, parent.name));
    } catch (e) {
      if (code(e) === 'ENOENT') return 'absent';
      throw e;
    }
    if (st.isSymbolicLink()) throw linkError(path);
    if (!st.isDirectory()) throw new Error(`${path} : pas un dossier, laissé en place`);
    try {
      rmdirSync(fdPath(parent.fd, parent.name));
      return 'removed';
    } catch (e) {
      if (code(e) === 'ENOTEMPTY' || code(e) === 'EEXIST') return 'not-empty';
      throw e;
    }
  } finally {
    closeSync(parent.fd);
  }
}

/** Noms d'un dossier de proc-watch ouvert sans suivre de lien (lui compris) ; absent → [], lien → erreur. */
export function listDirSafe(roots: readonly string[], path: string): string[] {
  const parent = openParent(roots, path, false);
  if (!parent) return [];
  try {
    let fd: number;
    try {
      fd = openSync(fdPath(parent.fd, parent.name), DIR_NOFOLLOW);
    } catch (e) {
      if (code(e) === 'ENOENT') return [];
      throw code(e) === 'ELOOP' ? linkError(path) : e;
    }
    try {
      return readdirSync(`/proc/self/fd/${fd}`);
    } finally {
      closeSync(fd);
    }
  } finally {
    closeSync(parent.fd);
  }
}
