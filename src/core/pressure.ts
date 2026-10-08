import type { SystemInfo } from './types';

/** Niveau de pression mémoire : mêmes seuils pour les jauges du renderer et l'icône de la barre des tâches. */
export type Level = 'ok' | 'warn' | 'bad';

export function swapPercent(s: SystemInfo): number {
  return s.swapTotalKB ? (1 - s.swapFreeKB / s.swapTotalKB) * 100 : 0;
}

/** swap ≥ 70 % ou PSI ≥ 25 → bad ; swap ≥ 50 % ou PSI ≥ 10 → warn. */
export function pressureLevel(s: SystemInfo): Level {
  const swap = swapPercent(s);
  const psi = s.psiSome10 ?? 0;
  if (swap >= 70 || psi >= 25) return 'bad';
  if (swap >= 50 || psi >= 10) return 'warn';
  return 'ok';
}
