// Anti-gel : lectures de /proc/<pid>/cgroup et de /sys/fs/cgroup (lecture seule), disponibilité, revérification.
// Limite connue : entre `reverify` et l'appel busctl, un PID peut encore être recyclé (fenêtre très courte, très
// improbable) ; systemd ne permet pas de passer un pidfd, cette fenêtre ne peut pas être éliminée côté service.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStat } from '../collector/parse';
import type { PlanTarget } from './plan';

/** Ligne « 0::/chemin » (cgroups v2) ; null sinon. */
export function parseCgroupFile(text: string): string | null {
  const lines = text.split('\n').filter((l) => l.startsWith('0::'));
  if (lines.length !== 1) return null; // absent ou ambigu
  const p = lines[0].slice(3).trim();
  if (!p.startsWith('/') || p.split('/').some((s) => s === '..' || s === '.')) return null;
  return p;
}

export function readCgroup(procRoot: string, pid: number): string | null {
  try {
    return parseCgroupFile(readFileSync(join(procRoot, String(pid), 'cgroup'), 'utf8'));
  } catch {
    return null;
  }
}

/** Préfixe « /user.slice/user-<uid>.slice/user@<uid>.service » d'un cgroup ; null s'il est hors du gestionnaire utilisateur. */
export function userBaseOf(cgroup: string | null, uid: number): string | null {
  if (!cgroup || cgroup.split('/').some((s) => s === '..' || s === '.')) return null;
  const m = /^\/user\.slice\/user-(\d+)\.slice\/user@(\d+)\.service(\/|$)/.exec(cgroup);
  if (!m || m[1] !== String(uid) || m[2] !== String(uid)) return null;
  return `/user.slice/user-${uid}.slice/user@${uid}.service`;
}

export type Availability = { ok: true; userBase: string; busctl: string } | { ok: false; reason: string };
export interface AvailabilityInput { cgroup2: boolean; selfCgroup: string | null; uid: number; subtreeControl: string | null; busctl: string | null }

export function availability(i: AvailabilityInput): Availability {
  if (!i.cgroup2) return { ok: false, reason: 'cgroups v2 absents (hiérarchie unifiée non montée)' };
  const userBase = userBaseOf(i.selfCgroup, i.uid);
  if (!userBase) return { ok: false, reason: 'le service ne tourne pas sous le gestionnaire systemd de l’utilisateur' };
  if (!i.subtreeControl || !i.subtreeControl.trim().split(/\s+/).includes('memory')) {
    return { ok: false, reason: 'contrôleur mémoire non délégué à la session (memory absent de cgroup.subtree_control)' };
  }
  if (!i.busctl) return { ok: false, reason: 'busctl introuvable (/usr/bin/busctl)' };
  return { ok: true, userBase, busctl: i.busctl };
}

export function probeAvailability(o: { procRoot: string; sysfsRoot: string; uid: number; selfPid: number; busctl: string | null }): Availability {
  const cgroup2 = existsSync(join(o.sysfsRoot, 'cgroup.controllers'));
  const selfCgroup = readCgroup(o.procRoot, o.selfPid);
  const base = userBaseOf(selfCgroup, o.uid);
  let subtreeControl: string | null = null;
  if (base) {
    try {
      subtreeControl = readFileSync(join(o.sysfsRoot, base, 'cgroup.subtree_control'), 'utf8');
    } catch {
      subtreeControl = null;
    }
  }
  return availability({ cgroup2, selfCgroup, uid: o.uid, subtreeControl, busctl: o.busctl });
}

export interface MemoryEvents { high: number; max: number; oom: number; oomKill: number }

export function parseMemoryEvents(text: string): MemoryEvents {
  const out: MemoryEvents = { high: 0, max: 0, oom: 0, oomKill: 0 };
  for (const line of text.split('\n')) {
    const [k, v] = line.trim().split(/\s+/);
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 0) continue;
    if (k === 'high') out.high = n;
    else if (k === 'max') out.max = n;
    else if (k === 'oom') out.oom = n;
    else if (k === 'oom_kill') out.oomKill = n;
  }
  return out;
}

/** memory.high / memory.max / memory.swap.max : « max » → null (pas de plafond) ; illisible → null. */
export function parseLimit(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

/** `populated` : au moins un processus dans le cgroup ou ses descendants (cgroup.events « populated 1 »). */
export interface CgroupStats { currentBytes: number; highBytes: number | null; maxBytes: number | null; swapMaxBytes: number | null; events: MemoryEvents; populated: boolean }

/** cgroup.events : ligne « populated 0|1 » ; illisible ou absente → true (dans le doute, la slice reste affichée). */
export function parsePopulated(text: string): boolean {
  const m = /^populated\s+([01])\s*$/m.exec(text);
  return m ? m[1] === '1' : true;
}

/** Mémoire d'un cgroup (chemin absolu dans la hiérarchie : « /user.slice/… ») ; null s'il n'existe pas. */
export function readCgroupStats(sysfsRoot: string, cgroupPath: string): CgroupStats | null {
  if (!cgroupPath.startsWith('/') || cgroupPath.split('/').some((s) => s === '..' || s === '.')) return null;
  const dir = join(sysfsRoot, cgroupPath);
  const read = (f: string) => readFileSync(join(dir, f), 'utf8');
  try {
    const currentText = read('memory.current').trim();
    if (!/^\d+$/.test(currentText)) return null; // illisible : pas de 0 silencieux
    const current = Number(currentText);
    if (!Number.isSafeInteger(current)) return null;
    const populated = () => {
      try {
        return parsePopulated(read('cgroup.events'));
      } catch {
        return true;
      }
    };
    let swapMax: number | null = null;
    try {
      swapMax = parseLimit(read('memory.swap.max'));
    } catch {
      swapMax = null; // pas de swap compté (swapaccount=0)
    }
    return {
      currentBytes: current,
      highBytes: parseLimit(read('memory.high')),
      maxBytes: parseLimit(read('memory.max')),
      swapMaxBytes: swapMax,
      events: parseMemoryEvents(read('memory.events')),
      populated: populated(),
    };
  } catch {
    return null;
  }
}

/** Revérification juste avant l'appel D-Bus : même starttime (pas de PID recyclé), vivant (ni zombie ni mort), même uid, toujours dans `cgroup`. */
export function stillSame(procRoot: string, uid: number, t: PlanTarget, cgroup: string): boolean {
  try {
    const dir = join(procRoot, String(t.pid));
    const stat = readFileSync(join(dir, 'stat'), 'utf8');
    if (parseStat(stat).starttime !== t.startTicks) return false;
    // État (champ 3, juste après la dernière « ) ») : un zombie (Z) ou un processus mort (X) n'est jamais déplacé.
    const state = stat.slice(stat.lastIndexOf(')') + 1).trim().charAt(0);
    if (state === 'Z' || state === 'X') return false;
    // Ligne « Uid: » : les quatre champs (réel, effectif, sauvé, fs) doivent valoir `uid` (écarte les binaires setuid).
    const m = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(readFileSync(join(dir, 'status'), 'utf8'));
    if (!m || m.slice(1).some((v) => Number(v) !== uid)) return false;
    return readCgroup(procRoot, t.pid) === cgroup;
  } catch {
    return false;
  }
}

export function reverify(procRoot: string, uid: number, targets: readonly PlanTarget[], cgroup: string): PlanTarget[] {
  return targets.filter((t) => stillSame(procRoot, uid, t, cgroup));
}
