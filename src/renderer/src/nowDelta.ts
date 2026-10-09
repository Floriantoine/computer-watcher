// src/renderer/src/nowDelta.ts — écart « alors vs maintenant » d'une valeur rejouée (tuiles et arbre du rejeu)
import { formatKB } from './format';

export type DeltaKind = 'kb' | 'count' | 'cpu';
/** higher : la valeur était plus haute alors qu'aujourd'hui ; lower : plus basse. */
export interface NowDelta { text: string; tone: 'higher' | 'lower'; title: string }

export const NOW_DELTA_TITLE = 'par rapport à maintenant';

/** Écart absolu minimal affiché : 10 Mo, 1 processus, 1 point de CPU. */
const MIN_ABS: Record<DeltaKind, number> = { kb: 10 * 1024, count: 1, cpu: 1 };
const MIN_REL_PCT = 1;

/**
 * Écart `then − now` (« + » : plus haut alors). Mémoire et processus : absolu puis relatif à maintenant (« +1,2 Go · +18 % ») ;
 * CPU : en points (« −9 pt »). null si une valeur manque, si l'écart est sous 1 % ou sous le minimum absolu (égalité comprise).
 */
export function nowDelta(then: number | null | undefined, now: number | null | undefined, kind: DeltaKind): NowDelta | null {
  if (then == null || now == null || !Number.isFinite(then) || !Number.isFinite(now)) return null;
  const d = then - now;
  if (Math.abs(d) < MIN_ABS[kind]) return null;
  const sign = d > 0 ? '+' : '−';
  const tone = d > 0 ? 'higher' : 'lower';
  if (kind === 'cpu') return { text: `${sign}${Math.round(Math.abs(d))} pt`, tone, title: NOW_DELTA_TITLE };
  const rel = now > 0 ? (Math.abs(d) / now) * 100 : null;
  if (rel !== null && rel < MIN_REL_PCT) return null;
  const abs = kind === 'kb' ? formatKB(Math.round(Math.abs(d))) : String(Math.round(Math.abs(d)));
  return { text: rel === null ? `${sign}${abs}` : `${sign}${abs} · ${sign}${Math.round(rel)} %`, tone, title: NOW_DELTA_TITLE };
}
