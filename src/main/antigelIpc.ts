// IPC `antigel:state` : lecture bornée de l'état écrit par le service. Le main n'appelle jamais busctl.
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { antigelView, MAX_STATE_BYTES, type AntigelView } from '../core/antigel/state';
import { antigelStatePath } from '../core/paths';

/** Au plus MAX_STATE_BYTES + 1 octets lus : un fichier plus gros est refusé sans être lu en entier. */
function readBounded(path: string): string | null {
  // O_NONBLOCK : un FIFO ne bloque pas l'ouverture ; O_NOFOLLOW : un lien symbolique est refusé (ELOOP)
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

export function readAntigelView(dataDir: string, now: number, intervalSec: number): AntigelView {
  let text: string | null = null;
  try {
    text = readBounded(antigelStatePath(dataDir));
  } catch {
    text = null;
  }
  return antigelView(text, now, intervalSec);
}
