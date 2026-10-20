// IPC `antigel:state` : lecture bornée de l'état écrit par le service. Le main n'appelle jamais busctl.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { antigelView, MAX_STATE_BYTES, type AntigelView } from '../core/antigel/state';
import { antigelStatePath } from '../core/paths';

/** Au plus MAX_STATE_BYTES + 1 octets lus : un fichier plus gros est refusé sans être lu en entier. */
function readBounded(path: string): string | null {
  const fd = openSync(path, 'r');
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(MAX_STATE_BYTES + 1);
    let n = 0;
    while (n < buf.length) {
      const r = readSync(fd, buf, n, buf.length - n, null);
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
