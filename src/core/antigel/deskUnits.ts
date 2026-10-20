// Anti-gel (lot 2, « bureau prioritaire ») : unités réelles du bureau (session.slice, terminaux, Claude), noms validés et
// valeurs voulues (pur, sans import Node). Seules propriétés jamais posées hors de cwatch.slice : MemoryLow, CPUWeight,
// IOWeight (protections et poids), jamais un plafond, un gel ni un signal.
import { isClaudeProc, isTerminalName } from '../rules/neverKill';
import type { ProcInfo } from '../types';
import { ROOT_SLICE } from './units';

export const SESSION_SLICE = 'session.slice';
/** session.slice (kwin, plasmashell, portails) : le plus haut ; le travail (cwatch.slice) en a 4 fois moins. */
export const DESK_CPU_WEIGHT = 200;
/** Slice de premier niveau qui contient un terminal ou Claude (app.slice) : applications comprises, au-dessus du travail. */
export const TERMINAL_CPU_WEIGHT = 150;
/** cwatch.slice (spec). */
export const WORK_CPU_WEIGHT = 50;
/** Défaut du noyau et de systemd pour cpu.weight et io.weight. */
export const DEFAULT_WEIGHT = 100;
export const WEIGHT_MIN = 1;
export const WEIGHT_MAX = 10_000;
/** Unités de terminaux ou de Claude protégées au plus (ordre stable par nom). */
export const MAX_TERMINAL_UNITS = 6;
const PAGE = 4096;

// Caractères d'un nom d'unité systemd ; « \ » seulement dans un échappement \xNN. Premier caractère alphanumérique (ni « - »
// ni « . »), jamais « cwatch… » (les unités de l'anti-gel ont leurs propres validations), 240 caractères au plus.
const C = String.raw`(?:[A-Za-z0-9:_.-]|\\x[0-9a-f]{2})`;
const CU = String.raw`(?:[A-Za-z0-9:_.@-]|\\x[0-9a-f]{2})`;
const DESK_SLICE_RE = new RegExp(String.raw`^(?!cwatch)[A-Za-z0-9]${C}{0,232}\.slice$`);
const DESK_UNIT_RE = new RegExp(String.raw`^(?!cwatch)[A-Za-z0-9]${CU}{0,230}\.(service|scope)$`);

export const isDeskSliceName = (s: unknown): s is string => typeof s === 'string' && s.length <= 240 && DESK_SLICE_RE.test(s);
export const isDeskUnitName = (s: unknown): s is string =>
  typeof s === 'string' && s.length <= 240 && s !== 'init.scope' && DESK_UNIT_RE.test(s);

/**
 * Unité systemd d'un processus du bureau d'après son cgroup : slices (hiérarchie systemd : « a.slice/a-b.slice ») puis le
 * premier segment .service ou .scope ; ce qui suit (sous-cgroups d'une unité déléguée) est ignoré. null : hors de user@,
 * sous cwatch.slice, unité directement sous user@, segment invalide.
 */
export function terminalUnitOf(cgroup: string | null, userBase: string): { slices: string[]; unit: string } | null {
  if (!cgroup || !cgroup.startsWith(`${userBase}/`)) return null;
  const segs = cgroup.slice(userBase.length + 1).split('/');
  const slices: string[] = [];
  for (const s of segs) {
    if (s.endsWith('.slice')) {
      if (!isDeskSliceName(s)) return null;
      const parent = slices[slices.length - 1];
      if (parent !== undefined && !s.startsWith(`${parent.slice(0, -'.slice'.length)}-`)) return null;
      slices.push(s);
      continue;
    }
    return isDeskUnitName(s) && slices.length > 0 ? { slices, unit: s } : null;
  }
  return null;
}

/** Ce que le contrôleur peut poser : poids CPU et E/S si les contrôleurs sont délégués, protection mémoire si elle peut agir. */
export interface DeskCaps { cpu: boolean; io: boolean; memory: boolean }
/** Valeurs voulues pour une unité ; une propriété absente n'est pas touchée. */
export interface DeskWant { cgroup: string; cpuWeight?: number; ioWeight?: number; memoryLow?: number }
export interface DeskTargets {
  /** Unité → valeurs voulues (ordre : session.slice, slices et unités des terminaux, cwatch.slice). */
  units: Map<string, DeskWant>;
  /** Unités de terminaux ou de Claude retenues. */
  terminals: string[];
  /** Plus de MAX_TERMINAL_UNITS unités trouvées. */
  truncated: boolean;
}

export interface DeskTargetsInput {
  procs: readonly ProcInfo[];
  uid: number;
  userBase: string;
  cgroupOf: (pid: number) => string | null;
  /** Réserve pour le bureau (octets) : la protection mémoire posée. */
  reserveBytes: number;
  caps: DeskCaps;
  /** cwatch.slice existe (sinon son poids attend le tick suivant). */
  rootExists: boolean;
}

export function deskTargets(i: DeskTargetsInput): DeskTargets {
  const found = new Map<string, { slices: string[]; unit: string; cgroup: string }>();
  for (const p of i.procs) {
    if (p.uid !== i.uid || p.cmdline.startsWith('[') || !(isTerminalName(p.name) || isClaudeProc(p))) continue;
    const t = terminalUnitOf(i.cgroupOf(p.pid), i.userBase);
    if (!t || found.has(t.unit)) continue;
    found.set(t.unit, { ...t, cgroup: `${i.userBase}/${t.slices.join('/')}/${t.unit}` });
  }
  const all = [...found.keys()].sort();
  const terminals = all.slice(0, MAX_TERMINAL_UNITS);
  const low = Math.floor(i.reserveBytes / PAGE) * PAGE;
  const mem = i.caps.memory && low > 0;
  const units = new Map<string, DeskWant>();
  const add = (unit: string, cgroup: string, cpu: number | null, withLow: boolean) => {
    const w: DeskWant = units.get(unit) ?? { cgroup };
    if (cpu !== null && i.caps.cpu) w.cpuWeight = Math.max(w.cpuWeight ?? 0, cpu);
    if (cpu !== null && i.caps.io) w.ioWeight = Math.max(w.ioWeight ?? 0, cpu);
    if (withLow && mem) w.memoryLow = low;
    if (Object.keys(w).length > 1) units.set(unit, w);
  };
  add(SESSION_SLICE, `${i.userBase}/${SESSION_SLICE}`, DESK_CPU_WEIGHT, true);
  for (const name of terminals) {
    const t = found.get(name)!;
    // poids sur la slice de premier niveau seulement (frère de cwatch.slice) ; protection sur toute la chaîne, sinon le
    // niveau intermédiaire la bornerait à zéro
    t.slices.forEach((s, k) => add(s, `${i.userBase}/${t.slices.slice(0, k + 1).join('/')}`, k === 0 ? TERMINAL_CPU_WEIGHT : null, true));
    add(t.unit, t.cgroup, null, true);
  }
  if (i.rootExists) add(ROOT_SLICE, `${i.userBase}/${ROOT_SLICE}`, WORK_CPU_WEIGHT, false);
  return { units, terminals, truncated: all.length > terminals.length };
}
