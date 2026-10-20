// Anti-gel : lecture bornée de antigel-state.json, partagée par le main (fenêtre) et le service (relecture au démarrage).
// Module Node à part : state.ts reste sans import Node (il sert aussi au renderer).
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { MAX_STATE_BYTES } from './state';

/**
 * Au plus MAX_STATE_BYTES + 1 octets lus : un fichier plus gros est refusé sans être lu en entier. O_NONBLOCK : un FIFO
 * ne bloque pas l'ouverture ; O_NOFOLLOW : un lien symbolique est refusé (ELOOP) ; autre chose qu'un fichier → null.
 * Lève si le fichier ne s'ouvre pas (absent…).
 */
export function readStateFileBounded(path: string): string | null {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(MAX_STATE_BYTES + 1);
    let n = 0;
    while (n < buf.length) {
      let r: number;
      try {
        r = readSync(fd, buf, n, buf.length - n, null);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EAGAIN') return null;
        throw e;
      }
      if (r === 0) break;
      n += r;
    }
    return n > MAX_STATE_BYTES ? null : buf.toString('utf8', 0, n);
  } finally {
    closeSync(fd);
  }
}
