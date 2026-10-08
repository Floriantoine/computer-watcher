import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Socket TCP en écoute : inode, port local, uid propriétaire (colonne `uid` de /proc/net/tcp[6]). */
export interface ListenSocket {
  inode: number;
  port: number;
  uid: number;
}

/** Contenu de /proc/net/tcp[6] → sockets LISTEN (st == 0A) seulement ; ligne illisible ignorée. */
export function parseNetTcpListen(content: string): ListenSocket[] {
  const out: ListenSocket[] = [];
  const lines = content.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].trim().split(/\s+/);
    if (f.length < 10 || f[3] !== '0A') continue;
    const colon = f[1].lastIndexOf(':');
    const port = parseInt(f[1].slice(colon + 1), 16);
    const uid = /^\d+$/.test(f[7]) ? Number(f[7]) : NaN;
    const inode = Number(f[9]);
    if (colon < 0 || !Number.isInteger(port) || !Number.isInteger(uid) || !Number.isInteger(inode) || inode === 0) continue;
    out.push({ inode, port, uid });
  }
  return out;
}

/** Contenu de /proc/net/tcp[6] → inode → port, lignes LISTEN (st == 0A) seulement. */
export function parseNetTcp(content: string): Map<number, number> {
  return new Map(parseNetTcpListen(content).map((s) => [s.inode, s.port]));
}

/** Sockets en écoute de tcp et tcp6, sans dédoublonnage (un inode par socket : sert à associer les fd aux ports). */
export function readAllListenSockets(procRoot = '/proc'): ListenSocket[] {
  const out: ListenSocket[] = [];
  for (const f of ['tcp', 'tcp6']) {
    try {
      out.push(...parseNetTcpListen(readFileSync(join(procRoot, 'net', f), 'utf8')));
    } catch {
      /* fichier absent */
    }
  }
  return out;
}

/**
 * Sockets en écoute de /proc/net/tcp et tcp6 (tous utilisateurs : l'uid y est lisible même quand les fd du processus ne le
 * sont pas), dédoublonnés par (port, uid) — le premier inode est gardé —, triés par port puis uid.
 */
export function readListenSockets(procRoot = '/proc'): ListenSocket[] {
  return dedupeSockets(readAllListenSockets(procRoot));
}

/** Dédoublonne par (port, uid) (premier inode gardé) et trie par port puis uid. */
export function dedupeSockets(all: readonly ListenSocket[]): ListenSocket[] {
  const seen = new Map<string, ListenSocket>();
  for (const s of all) {
    const k = `${s.port}:${s.uid}`;
    if (!seen.has(k)) seen.set(k, s);
  }
  return [...seen.values()].sort((a, b) => a.port - b.port || a.uid - b.uid);
}

const SOCKET_RE = /^socket:\[(\d+)\]$/;

/** Plafond de fd parcourus par lecture (tous pids confondus) : un processus à des dizaines de milliers de fd ne coûte pas une seconde. */
export const MAX_FDS_PER_READ = 20_000;

/**
 * pid → ports TCP en écoute (triés, uniques). Toute erreur d'accès → pid absent du résultat.
 * Au-delà de `maxFds` fd parcourus, les pids restants sont ignorés. `sockets` : sockets déjà lus (tous, non dédoublonnés),
 * pour ne pas relire /proc/net.
 */
export function readListeningPorts(pids: number[], procRoot = '/proc', maxFds = MAX_FDS_PER_READ, sockets?: readonly ListenSocket[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const byInode = new Map<number, number>();
  for (const s of sockets ?? readAllListenSockets(procRoot)) byInode.set(s.inode, s.port);
  if (byInode.size === 0) return out;
  let budget = maxFds;
  for (const pid of pids) {
    const dir = join(procRoot, String(pid), 'fd');
    let fds: string[];
    try {
      fds = readdirSync(dir);
    } catch {
      continue;
    }
    budget -= fds.length;
    if (budget < 0) break;
    const ports = portsOf(dir, fds, byInode);
    if (ports) out.set(pid, ports);
  }
  return out;
}

function portsOf(dir: string, fds: string[], byInode: ReadonlyMap<number, number>): number[] | null {
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
  return ports.size ? [...ports].sort((a, b) => a - b) : null;
}

/**
 * Lecture par tranches (pour ne pas bloquer le main) : à partir de `pids[start]`, lit les pids tant que le total de fd parcourus
 * reste ≤ `maxFds` (au moins un pid lisible par tranche ; un pid à plus de MAX_FDS_PER_READ fd est sauté). `next` : indice du
 * prochain pid à lire (`pids.length` en fin de liste).
 */
export function readListeningPortsSlice(pids: readonly number[], start: number, sockets: readonly ListenSocket[], maxFds: number, procRoot = '/proc'): { ports: Map<number, number[]>; next: number } {
  const out = new Map<number, number[]>();
  const byInode = new Map<number, number>();
  for (const s of sockets) byInode.set(s.inode, s.port);
  if (byInode.size === 0) return { ports: out, next: pids.length };
  let used = 0;
  let i = start;
  for (; i < pids.length; i++) {
    const dir = join(procRoot, String(pids[i]), 'fd');
    let fds: string[];
    try {
      fds = readdirSync(dir);
    } catch {
      continue;
    }
    if (fds.length > MAX_FDS_PER_READ) continue;
    if (used > 0 && used + fds.length > maxFds) break;
    used += fds.length;
    const ports = portsOf(dir, fds, byInode);
    if (ports) out.set(pids[i], ports);
  }
  return { ports: out, next: i };
}
