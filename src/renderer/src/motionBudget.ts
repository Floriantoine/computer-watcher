// Petites règles pour ne pas produire d'images (frames) qui ne montrent rien : chaque snapshot (toutes les 3 s)
// ferait sinon tourner ~0,7 s d'animation à 60 i/s pour des variations invisibles.

const STEPS = 8;

/** Variation relative en dessous de laquelle un nombre saute à sa nouvelle valeur (dérive ordinaire entre deux snapshots). */
const MIN_CHANGE = 0.05;

/**
 * Vrai si la variation est notable (≥ 5 %) et qu'une transition de `from` à `to` afficherait au moins une valeur
 * intermédiaire distincte. Sinon (petite dérive, même texte, ou un seul cran : 9,5 Go → 9,6 Go) : on saute.
 */
export function worthAnimating(from: number, to: number, format: (n: number) => string): boolean {
  if (Math.abs(to - from) < MIN_CHANGE * Math.max(Math.abs(from), Math.abs(to))) return false;
  const seen = new Set<string>();
  for (let i = 0; i <= STEPS; i++) {
    seen.add(format(Math.round(from + ((to - from) * i) / STEPS)));
    if (seen.size >= 3) return true;
  }
  return false;
}

/** Largeur CSS d'une jauge, au pour-cent près : une variation infime ne relance pas la transition de largeur. */
export function barWidth(percent: number): string {
  const p = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  return `${Math.round(p)}%`;
}

/** Durée d'un glissement de nombre et intervalle entre deux valeurs affichées (20 i/s au lieu de la fréquence de l'écran). */
export const TWEEN_MS = 600;
export const TWEEN_TICK_MS = 50;

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/** Valeurs successives d'un glissement de `from` à `to` (la dernière vaut exactement `to`). */
export function tweenSteps(from: number, to: number): number[] {
  const n = Math.round(TWEEN_MS / TWEEN_TICK_MS);
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? to : from + (to - from) * easeOutCubic((i + 1) / n)));
}
