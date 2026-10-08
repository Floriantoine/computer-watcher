import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeProc {
  pid: number;
  comm: string;
  ppid?: number;
  uid?: number;
  utime?: number;
  stime?: number;
  starttime?: number;
  /** Champ rss de stat (pages) */
  rssPages?: number;
  /** undefined → pas de ligne VmRSS (thread noyau) */
  rssKB?: number;
  swapKB?: number;
  /** undefined → [comm] ; [] → cmdline vide */
  cmdline?: string[];
  /** undefined → '/' ; null → pas de lien (cwd illisible) */
  cwd?: string | null;
  /** n'écrire que le fichier stat, pour simuler un processus mort en cours de lecture */
  partial?: boolean;
}

export function makeProcRoot(uptimeSec = 1000): string {
  const root = mkdtempSync(join(tmpdir(), 'procwatch-'));
  writeFileSync(join(root, 'uptime'), `${uptimeSec.toFixed(2)} 0.00\n`);
  return root;
}

export function addProc(root: string, p: FakeProc): void {
  const dir = join(root, String(p.pid));
  mkdirSync(dir);
  // Champs 3 à 22 de proc(5) : état, ppid, pgrp, session, tty, tpgid, flags,
  // minflt, cminflt, majflt, cmajflt, utime, stime, cutime, cstime, priority, nice, threads, itreal, starttime
  const fields = ['S', p.ppid ?? 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, p.utime ?? 0, p.stime ?? 0, 0, 0, 20, 0, 1, 0, p.starttime ?? 0, 0, p.rssPages ?? 0];
  writeFileSync(join(dir, 'stat'), `${p.pid} (${p.comm}) ${fields.join(' ')}\n`);
  if (p.partial) return;
  const uid = p.uid ?? 1000;
  let status = `Name:\t${p.comm}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
  if (p.rssKB !== undefined) status += `VmRSS:\t${p.rssKB} kB\nVmSwap:\t${p.swapKB ?? 0} kB\n`;
  writeFileSync(join(dir, 'status'), status);
  const argv = p.cmdline ?? [p.comm];
  writeFileSync(join(dir, 'cmdline'), argv.length ? argv.join('\0') + '\0' : '');
  if (p.cwd !== null) symlinkSync(p.cwd ?? '/', join(dir, 'cwd'));
}

/** Écrit /proc/net/tcp (ou tcp6) factice ; `lines` = lignes de données (l'en-tête est ajouté). */
export function writeNetTcp(root: string, lines: string[], file: 'tcp' | 'tcp6' = 'tcp'): void {
  mkdirSync(join(root, 'net'), { recursive: true });
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
  writeFileSync(join(root, 'net', file), header + lines.join('\n') + (lines.length ? '\n' : ''));
}

/** Ajoute un fd `socket:[inode]` au processus déjà créé par addProc. */
export function addSocketFd(root: string, pid: number, fd: number, inode: number): void {
  const dir = join(root, String(pid), 'fd');
  mkdirSync(dir, { recursive: true });
  symlinkSync(`socket:[${inode}]`, join(dir, String(fd)));
}
