import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Contenu de /proc/net/tcp[6] → inode → port, lignes LISTEN (st == 0A) seulement. */
export function parseNetTcp(content: string): Map<number, number> {
  const out = new Map<number, number>();
  const lines = content.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].trim().split(/\s+/);
    if (f.length < 10 || f[3] !== '0A') continue;
    const colon = f[1].lastIndexOf(':');
    const port = parseInt(f[1].slice(colon + 1), 16);
    const inode = Number(f[9]);
    if (colon < 0 || !Number.isInteger(port) || !Number.isInteger(inode) || inode === 0) continue;
    out.set(inode, port);
  }
  return out;
}

const SOCKET_RE = /^socket:\[(\d+)\]$/;

/** pid → ports TCP en écoute (triés, uniques). Toute erreur d'accès → pid absent du résultat. */
export function readListeningPorts(pids: number[], procRoot = '/proc'): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const byInode = new Map<number, number>();
  for (const f of ['tcp', 'tcp6']) {
    try {
      for (const [inode, port] of parseNetTcp(readFileSync(join(procRoot, 'net', f), 'utf8'))) byInode.set(inode, port);
    } catch {
      /* fichier absent */
    }
  }
  if (byInode.size === 0) return out;
  for (const pid of pids) {
    const dir = join(procRoot, String(pid), 'fd');
    let fds: string[];
    try {
      fds = readdirSync(dir);
    } catch {
      continue;
    }
    const ports = new Set<number>();
    for (const fd of fds) {
      try {
        const m = SOCKET_RE.exec(readlinkSync(join(dir, fd)));
        const port = m ? byInode.get(Number(m[1])) : undefined;
        if (port !== undefined) ports.add(port);
      } catch {
        /* fd fermé entre-temps */
      }
    }
    if (ports.size) out.set(pid, [...ports].sort((a, b) => a - b));
  }
  return out;
}
