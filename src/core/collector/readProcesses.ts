import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ProcSample } from '../types';
import { parseCmdline, parseStat, parseStatus } from './parse';

export const CLK_TCK = 100;
const DELETED_SUFFIX = ' (deleted)';

function readCwd(dir: string): { cwd: string | null; cwdDeleted: boolean } {
  try {
    const link = readlinkSync(join(dir, 'cwd'));
    const cwdDeleted = link.endsWith(DELETED_SUFFIX);
    return { cwd: cwdDeleted ? link.slice(0, -DELETED_SUFFIX.length) : link, cwdDeleted };
  } catch {
    return { cwd: null, cwdDeleted: false };
  }
}

export interface ReadOptions {
  /** Si fourni : le lien cwd n'est lu que pour les noms acceptés (coûteux sur ~750 processus). */
  wantCwd?: (name: string) => boolean;
}

export function readProcesses(procRoot = '/proc', opts: ReadOptions = {}): ProcSample[] {
  const uptimeSec = parseFloat(readFileSync(join(procRoot, 'uptime'), 'utf8').split(' ')[0]);
  const out: ProcSample[] = [];
  for (const entry of readdirSync(procRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    const dir = join(procRoot, entry);
    let stat, status, cmdline;
    try {
      stat = parseStat(readFileSync(join(dir, 'stat'), 'utf8'));
      status = parseStatus(readFileSync(join(dir, 'status'), 'utf8'));
      cmdline = parseCmdline(readFileSync(join(dir, 'cmdline'), 'utf8'));
    } catch {
      continue; // processus terminé entre readdir et la lecture
    }
    out.push({
      pid: Number(entry),
      ppid: stat.ppid,
      name: status.name,
      cmdline: cmdline || `[${status.name}]`,
      uid: status.uid,
      startTicks: stat.starttime,
      ageSec: Math.max(0, uptimeSec - stat.starttime / CLK_TCK),
      cpuTicks: stat.utime + stat.stime,
      rssKB: status.rssKB,
      swapKB: status.swapKB,
      ...(opts.wantCwd && !opts.wantCwd(status.name) ? { cwd: null, cwdDeleted: false } : readCwd(dir)),
    });
  }
  return out;
}
