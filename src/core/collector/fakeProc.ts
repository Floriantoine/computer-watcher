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
  const fields = ['S', p.ppid ?? 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, p.utime ?? 0, p.stime ?? 0, 0, 0, 20, 0, 1, 0, p.starttime ?? 0, 0, 0];
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
