// Tri avec hystérésis : deux cartes de mémoire (ou de CPU) voisine échangeraient leur place à chaque snapshot,
// chaque fois avec une animation de réorganisation. On garde l'ordre précédent tant que l'écart reste sous la tolérance.

/**
 * Part de l'ordre précédent (les nouveaux en fin, dans l'ordre de `sorted`), puis échange deux voisins seulement si
 * `outOfOrder(a, b)` (a, placé avant b, devrait passer après au-delà de la tolérance), jusqu'à stabilité.
 */
export function stableOrder<T>(sorted: readonly T[], prevIds: readonly string[], id: (t: T) => string, outOfOrder: (a: T, b: T) => boolean): T[] {
  const prev = new Map(prevIds.map((x, i) => [x, i]));
  const list = sorted
    .map((t, i) => ({ t, k: prev.get(id(t)) ?? prevIds.length + i }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.t);
  for (let pass = 0; pass < list.length; pass++) {
    let swapped = false;
    for (let i = 0; i + 1 < list.length; i++) {
      if (outOfOrder(list[i]!, list[i + 1]!)) {
        [list[i], list[i + 1]] = [list[i + 1]!, list[i]!];
        swapped = true;
      }
    }
    if (!swapped) break;
  }
  return list;
}

interface Measured {
  rssKB: number;
  swapKB: number;
  cpuPercent: number;
}

const memKB = (g: Measured) => g.rssKB + g.swapKB;

/** Tri mémoire décroissant : b passe devant a s'il le dépasse de plus de 5 % ou 8 Mo (le plus grand des deux). */
export const memOutOfOrder = (a: Measured, b: Measured): boolean => memKB(b) - memKB(a) > Math.max(0.05 * memKB(b), 8 * 1024);

/** Tri CPU décroissant : b passe devant a s'il le dépasse de plus de 2 points ou 10 %. */
export const cpuOutOfOrder = (a: Measured, b: Measured): boolean => b.cpuPercent - a.cpuPercent > Math.max(2, 0.1 * b.cpuPercent);
