import type { GroupKind, GroupSummary, InstanceSummary } from '../../core/types';

/** Groupes hors projet : une seule instance (le groupe entier), reclassable depuis l'en-tête du détail. */
const HEADER_KINDS: ReadonlySet<GroupKind> = new Set(['app', 'command', 'claude']);

/**
 * Instance unique d'un groupe app / command / claude (sous-groupes de « Autres » compris) ; null pour project, deleted,
 * others, ou sans instance (sous-groupe pas encore classé).
 */
export function headerReclassTarget(g: GroupSummary): InstanceSummary | null {
  if (!HEADER_KINDS.has(g.kind) || g.instances.length !== 1) return null;
  return g.instances[0]!;
}
