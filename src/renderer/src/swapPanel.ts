// Panneau « Swap » de l'onglet Métriques : fonctions pures (libellés, instances à arrêter, bouton de ligne).
import type { SleepState, SwapRow, SwapView } from '../../core/swap';
import type { GroupSummary, InstanceSummary } from '../../core/types';
import { formatAge } from './format';

/** « actif » | « endormi depuis 3 j » | « endormi depuis plus de 30 j » (aucune activité dans l'historique) | « inconnu (historique insuffisant) ». */
export function sleepLabel(s: SleepState, now: number, historyFrom: number | null): string {
  if (s.kind === 'active') return 'actif';
  if (s.kind === 'unknown') return 'inconnu (historique insuffisant)';
  if (s.sinceTs !== null) return `endormi depuis ${formatAge(Math.max(0, now - s.sinceTs) / 1000)}`;
  return historyFrom === null ? 'endormi' : `endormi depuis plus de ${formatAge(Math.max(0, now - historyFrom) / 1000)}`;
}

export const stopSleepingLabel = (n: number): string => `Arrêter les endormis (${n})`;

export const STOP_SLEEPING_HINT = 'Seules les instances de projets sont proposées';

/**
 * Instances de `sleepingKeys` encore présentes au snapshot (sous-groupes compris), pour le kill groupé. Défense en plus du
 * main : seulement des instances non protégées, pas lancées par Claude, de groupes projet / dossier supprimé.
 */
export function sleepingInstances(view: SwapView | null | undefined, groups: readonly GroupSummary[]): InstanceSummary[] {
  if (!view || view.sleepingKeys.length === 0) return [];
  const byKey = new Map<string, InstanceSummary>();
  const walk = (gs: readonly GroupSummary[]) => {
    for (const g of gs) {
      if (g.kind === 'project' || g.kind === 'deleted') for (const i of g.instances) byKey.set(i.key, i);
      walk(g.subgroups);
    }
  };
  walk(groups);
  return view.sleepingKeys.flatMap((k) => {
    const i = byKey.get(k);
    return i && !i.protected && i.launchedBy !== 'claude' ? [i] : [];
  });
}

const STOPPABLE_KINDS = new Set(['app', 'command']);

/** Bouton de la ligne : « Arrêter » pour une appli endormie tuable (jamais Claude ni protégée) ; les instances de projet passent par l'arrêt groupé. */
export function rowAction(row: SwapRow): 'none' | 'stop-one' {
  return row.state.kind === 'sleeping' && row.killable && !row.protected && STOPPABLE_KINDS.has(row.kind) && row.children.length === 0 ? 'stop-one' : 'none';
}

/**
 * Garde du clic « Arrêter » (le bouton n'est rendu que si `rowAction` le permet) : le groupe doit encore s'y prêter. `g` : groupe
 * du dernier snapshot, ou la ligne elle-même pour un sous-groupe de « Autres » replié (absent des résumés) ; undefined → disparu.
 */
export function stopOneCheck(row: SwapRow, g: Pick<GroupSummary, 'kind' | 'protected' | 'killable'> | undefined): { ok: true } | { ok: false; message: string } {
  if (!g) return { ok: false, message: `« ${row.label} » a disparu` };
  if (rowAction(row) !== 'stop-one' || !STOPPABLE_KINDS.has(g.kind) || g.protected || !g.killable)
    return { ok: false, message: `« ${row.label} » ne peut pas être arrêté depuis la vue swap` };
  return { ok: true };
}

/** Saisie du seuil « endormi » (Mo) : entier de 1 à 65 536, comme la validation de la config ; sinon null. */
export function parseSwapSleepMB(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 65_536 ? n : null;
}
