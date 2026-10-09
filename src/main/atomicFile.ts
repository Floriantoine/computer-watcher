// Écritures atomiques : fichier temporaire du même dossier (créé en exclusif), fsync, rename, fsync du dossier.
// Un lien symbolique posé à la destination est remplacé par rename, jamais suivi.
import { closeSync, copyFileSync, constants, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync, chmodSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const tmpName = (dest: string) => join(dirname(dest), `.${basename(dest)}.${process.pid}.${Date.now()}.tmp`);

function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // certains systèmes de fichiers refusent fsync sur un dossier : le rename reste atomique
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function commit(tmp: string, dest: string, mode: number): void {
  const fd = openSync(tmp, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, mode); // indépendant de l'umask
  renameSync(tmp, dest);
  fsyncDir(dirname(dest));
}

export function writeFileAtomic(dest: string, data: string | Buffer, mode = 0o644): void {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = tmpName(dest);
  try {
    const fd = openSync(tmp, 'wx', mode);
    try {
      const buf = typeof data === 'string' ? Buffer.from(data) : data;
      let off = 0;
      while (off < buf.length) off += writeSync(fd, buf, off);
    } finally {
      closeSync(fd);
    }
    commit(tmp, dest, mode);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export function copyFileAtomic(src: string, dest: string, mode = 0o644): void {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = tmpName(dest);
  try {
    copyFileSync(src, tmp, constants.COPYFILE_EXCL);
    commit(tmp, dest, mode);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Comme copyFileAtomic, sans bloquer le main pendant la copie (AppImage de ~150 Mo). */
export async function copyFileAtomicAsync(src: string, dest: string, mode = 0o644): Promise<void> {
  await fsp.mkdir(dirname(dest), { recursive: true });
  const tmp = tmpName(dest);
  try {
    await fsp.copyFile(src, tmp, constants.COPYFILE_EXCL);
    const fh = await fsp.open(tmp, 'r+');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.chmod(tmp, mode);
    await fsp.rename(tmp, dest);
    fsyncDir(dirname(dest));
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
}
