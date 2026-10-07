import type { SystemInfo } from '../../core/types';
import { pressureLevel, type Level } from './viewModel';

/** Teintes sombres des carrés d'icône de groupe (icône claire par-dessus). */
export const ICON_PALETTE = ['#1f3b8a', '#5b2d8a', '#0f5d4f', '#14532d', '#7a2348', '#6b4513', '#155e75', '#3f3a8c'] as const;

/** Couleur d'icône stable pour un groupe : hash FNV-1a de l'id → palette. */
export function groupIconColor(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ICON_PALETTE[(h >>> 0) % ICON_PALETTE.length]!;
}

/** Niveau d'une carte selon sa part de la RAM totale (en %). */
export function cardLevel(pct: number): Level {
  return pct >= 20 ? 'bad' : pct >= 8 ? 'warn' : 'ok';
}

export type GaugeKind = 'mem' | 'swap' | 'psi';
export type GaugeTone = GaugeKind | 'warn' | 'bad';

/** Dégradé d'une jauge système : sa teinte propre, sauf alerte de pressureLevel. */
export function gaugeTone(kind: GaugeKind, level: Level): GaugeTone {
  return level === 'ok' ? kind : level;
}

/** Dégradé de la jauge d'une carte : violet si faible, ambre si notable, rose-orange si lourde. */
export function cardTone(pct: number): GaugeTone {
  return ({ ok: 'mem', warn: 'warn', bad: 'swap' } as const)[cardLevel(pct)];
}

/**
 * Part de pressureLevel due à chaque métrique : on l'évalue avec le swap seul, puis la PSI seule,
 * pour colorer en alerte la jauge qui en est la cause (mêmes seuils que pressureLevel).
 */
export function metricLevels(s: SystemInfo): { swap: Level; psi: Level } {
  return {
    swap: pressureLevel({ ...s, psiSome10: null }),
    psi: pressureLevel({ ...s, swapTotalKB: 0, swapFreeKB: 0 }),
  };
}
