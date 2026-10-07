// Hystérésis des cartes : un groupe qui passe juste au-dessus puis au-dessous des seuils de « Autres » (un pic CPU
// de 1 %, par exemple) ferait apparaître et disparaître sa carte à chaque snapshot, avec animations de sortie et de
// réorganisation. Une carte affichée reste donc affichée HOLD ms après être repassée sous les seuils.

/** Note les groupes affichés à part (hors « Autres ») à l'instant `now`. */
export function recordSeparate(seen: Map<string, number>, groups: { id: string; kind: string }[], now: number): void {
  for (const g of groups) if (g.kind !== 'others') seen.set(g.id, now);
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
