import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ProcSample } from '../types';
import { parseCmdline, parseStat, parseStatus, type StatusFields } from './parse';

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

export interface CwdEntry {
  cwd: string | null;
  cwdDeleted: boolean;
  /** Instant de la dernière lecture du lien */
  at: number;
}

export interface StatusEntry {
  status: StatusFields;
  /** RSS lu dans stat lors de la dernière lecture de status */
  rssPages: number;
  at: number;
}

export interface ReadOptions {
  /** Si fourni : le lien cwd n'est lu que pour les noms acceptés (coûteux sur ~750 processus). */
  wantCwd?: (name: string) => boolean;
  /**
   * Cache cmdline `${pid}:${starttime}:${comm}` → ligne de commande : lue une seule fois par processus, purgée des absents à chaque passe.
   * Le nom fait partie de la clé : un exec (même PID, même starttime) change le nom et force une relecture.
   */
  cmdlineCache?: Map<string, string>;
  /**
   * Cache du lien cwd (même clé) : relu au plus toutes les `maxAgeMs` pour un processus donné
   * (le dossier de travail change rarement), purgé des absents à chaque passe.
   */
  cwdCache?: { entries: Map<string, CwdEntry>; now: number; maxAgeMs: number };
  /**
   * Cache de /proc/<pid>/status (même clé) : relu seulement si le RSS de stat a changé (une page qui part en swap fait
   * baisser le RSS) ou après `maxAgeMs`. La plupart des ~700 processus dorment : une lecture sur deux évitée.
   */
  statusCache?: { entries: Map<string, StatusEntry>; now: number; maxAgeMs: number };
}

export function readProcesses(procRoot = '/proc', opts: ReadOptions = {}): ProcSample[] {
  const uptimeSec = parseFloat(readFileSync(join(procRoot, 'uptime'), 'utf8').split(' ')[0]);
  const out: ProcSample[] = [];
  const cache = opts.cmdlineCache;
  const cwdCache = opts.cwdCache;
  const statusCache = opts.statusCache;
  const seen = cache || cwdCache || statusCache ? new Set<string>() : null;
  const cwdOf = (dir: string, key: string): { cwd: string | null; cwdDeleted: boolean } => {
    if (!cwdCache) return readCwd(dir);
    const hit = cwdCache.entries.get(key);
    if (hit && cwdCache.now - hit.at < cwdCache.maxAgeMs) return { cwd: hit.cwd, cwdDeleted: hit.cwdDeleted };
    const r = readCwd(dir);
    cwdCache.entries.set(key, { ...r, at: cwdCache.now });
    return r;
  };
  for (const entry of readdirSync(procRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    const dir = join(procRoot, entry);
    let stat, status, cmdline, key: string;
    try {
      stat = parseStat(readFileSync(join(dir, 'stat'), 'utf8'));
      key = `${entry}:${stat.starttime}:${stat.comm}`;
      if (seen) seen.add(key);
      const hit = statusCache?.entries.get(key);
      if (statusCache && hit && hit.rssPages === stat.rssPages && statusCache.now - hit.at < statusCache.maxAgeMs) status = hit.status;
      else {
        status = parseStatus(readFileSync(join(dir, 'status'), 'utf8'));
        statusCache?.entries.set(key, { status, rssPages: stat.rssPages, at: statusCache.now });
      }
      if (cache) {
        let c = cache.get(key);
        if (c === undefined) {
          c = parseCmdline(readFileSync(join(dir, 'cmdline'), 'utf8'));
          cache.set(key, c);
        }
        cmdline = c;
      } else {
        cmdline = parseCmdline(readFileSync(join(dir, 'cmdline'), 'utf8'));
      }
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
      ...(opts.wantCwd && !opts.wantCwd(status.name) ? { cwd: null, cwdDeleted: false } : cwdOf(dir, key)),
    });
  }
  if (cache && seen) for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k);
  if (cwdCache && seen) for (const k of cwdCache.entries.keys()) if (!seen.has(k)) cwdCache.entries.delete(k);
  if (statusCache && seen) for (const k of statusCache.entries.keys()) if (!seen.has(k)) statusCache.entries.delete(k);
  return out;
}
