// src/core/collector/interactivePressure.ts — pression mémoire (PSI « full » avg10) de ce que l'utilisateur voit : le bureau
// et les applis. Le travail rangé dans cwatch.slice n'y compte pas : un projet freiné par son budget (memory.high) fait
// monter la PSI de toute la machine (un seul processus freiné, machine au repos : some 29 %, full 25 %) sans que le bureau
// attende quoi que ce soit.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePsiFull10 } from './parse';

/** `interactive` : cgroups du bureau et des applis ; `system` : repli sur toute la machine (/proc/pressure/memory). */
export type PressureScope = 'interactive' | 'system';
export interface MemPressure { percent: number; scope: PressureScope }

/** Slices du gestionnaire utilisateur (user@<uid>.service) où vivent le bureau (KWin, Plasma, portails) et les applis. */
export const INTERACTIVE_SLICES = ['session.slice', 'app.slice'] as const;
/**
 * Sessions de connexion (user-<uid>.slice/session-<id>.scope) : le bureau quand il ne tourne pas sous le gestionnaire
 * utilisateur (XFCE, i3, X11 sans systemd), une console (TTY), une connexion ssh. Jamais budgétées.
 */
const SESSION_SCOPE = /^session-[A-Za-z0-9]{1,32}\.scope$/;
/** Sessions lues au plus (ordre stable par nom). */
export const MAX_SESSIONS = 16;

const full = (path: string): number | null => {
  try {
    const v = parsePsiFull10(readFileSync(path, 'utf8'));
    return v !== null && Number.isFinite(v) ? v : null;
  } catch {
    return null; // absent, illisible ou PSI coupée pour ce cgroup
  }
};

/**
 * Pression « full » avg10 (%) du bureau et des applis : la plus haute de session.slice, app.slice et des sessions de
 * connexion de l'utilisateur. Aucune lisible (pas de systemd, cgroups v1, `cgroupRoot` null) : celle de la machine
 * (`globalFull10`) ; null si elle manque aussi. Chemins construits depuis l'uid (entier), jamais depuis un texte lu.
 */
export function readInteractivePressure(o: { cgroupRoot: string | null; uid: number; globalFull10: number | null }): MemPressure | null {
  if (o.cgroupRoot !== null && Number.isSafeInteger(o.uid) && o.uid >= 0) {
    const user = join(o.cgroupRoot, 'user.slice', `user-${o.uid}.slice`);
    const files = INTERACTIVE_SLICES.map((s) => join(user, `user@${o.uid}.service`, s, 'memory.pressure'));
    try {
      for (const n of readdirSync(user).filter((x) => SESSION_SCOPE.test(x)).sort().slice(0, MAX_SESSIONS)) files.push(join(user, n, 'memory.pressure'));
    } catch {
      // pas de slice utilisateur lisible
    }
    let max: number | null = null;
    for (const f of files) {
      const v = full(f);
      if (v !== null && (max === null || v > max)) max = v;
    }
    if (max !== null) return { percent: max, scope: 'interactive' };
  }
  return o.globalFull10 !== null && Number.isFinite(o.globalFull10) ? { percent: o.globalFull10, scope: 'system' } : null;
}
