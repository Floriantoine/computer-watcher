// Hystérésis des cartes : un groupe qui passe juste au-dessus puis au-dessous des seuils de « Autres » (un pic CPU
// de 1 %, par exemple) ferait apparaître et disparaître sa carte à chaque snapshot, avec animations de sortie et de
// réorganisation. Une carte affichée reste donc affichée HOLD ms après être repassée sous les seuils.

/**
 * Note à l'instant `now` les groupes à part **par eux-mêmes** (`overThreshold`) : ni ceux gardés seulement par
 * l'hystérésis (sinon ils ne retomberaient jamais dans « Autres »), ni le dernier petit groupe laissé seul.
 */
export function recordSeparate<G extends { id: string; kind: string }>(seen: Map<string, number>, groups: G[], now: number, overThreshold: (g: G) => boolean): void {
  for (const g of groups) if (g.kind !== 'others' && overThreshold(g)) seen.set(g.id, now);
}

/** Groupes à garder à part : affichés il y a moins de `holdMs`. Oublie les autres. */
export function stickyIds(seen: Map<string, number>, now: number, holdMs: number): Set<string> {
  const out = new Set<string>();
  for (const [id, at] of seen) {
    if (now - at < holdMs) out.add(id);
    else seen.delete(id);
  }
  return out;
}
