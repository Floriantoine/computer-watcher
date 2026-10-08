// Panneau « Swap » de l'onglet Métriques : fonctions pures (libellés, instances à arrêter, bouton de ligne, seuil).
import { isSessionService, type SleepState, type SwapRow, type SwapView, type UnknownReason } from '../../core/swap';
import type { GroupSummary, InstanceSummary } from '../../core/types';
import { formatAge } from './format';

const UNKNOWN_LABELS: Record<UnknownReason, string> = {
  none: "inconnu (pas d'historique)",
  stopped: "inconnu (service d'enregistrement arrêté)",
  gap: "inconnu (trou dans l'historique)",
  short: 'inconnu (historique insuffisant)',
};

/**
 * « actif » | « endormi depuis 3 j » | « endormi depuis plus de 7 j » (aucune activité dans la couverture continue lue, au plus
 * 7 j) | « inconnu (raison) ».
 */
export function sleepLabel(s: SleepState, now: number, coveredFrom: number | null): string {
  if (s.kind === 'active') return 'actif';
  if (s.kind === 'unknown') return UNKNOWN_LABELS[s.reason];
  if (s.sinceTs !== null) return `endormi depuis ${formatAge(Math.max(0, now - s.sinceTs) / 1000)}`;
  return coveredFrom === null ? 'endormi' : `endormi depuis plus de ${formatAge(Math.max(0, now - coveredFrom) / 1000)}`;
}

const pct = (n: number) => String(n).replace('.', ',');

/** Règle affichée sous la jauge : seuil de swap et seuil CPU réellement appliqué. */
export const swapRuleText = (minMB: number, activeCpu: number): string =>
  `Endormi : plus de ${minMB} Mo de swap cumulé et aucun CPU ≥ ${pct(activeCpu)} % depuis 1 jour.`;

export const stopSleepingLabel = (n: number): string => `Arrêter les endormis (${n})`;

export const STOP_SLEEPING_HINT =
  'Seules les instances de projets sont proposées (ni protégées, ni lancées par une session Claude encore ouverte)';
export const CLAUDE_NOT_PROPOSED = 'Non proposée : sa session Claude est encore ouverte';

/**
 * Instances de `sleepingKeys` encore présentes au snapshot (sous-groupes compris), pour le kill groupé. Défense en plus du
 * main : seulement des instances non protégées, pas lancées par Claude, de groupes projet / dossier supprimé.
 */
export function sleepingInstances(view: Pick<SwapView, 'sleepingKeys'> | null | undefined, groups: readonly GroupSummary[]): InstanceSummary[] {
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

/** Seules les applis (navigateur, lecteur…) ont un « Arrêter » individuel : jamais `command` (démons de session, processus regroupés par nom). */
const STOPPABLE_KINDS = new Set(['app']);

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

/** Au clic : la vue relue dit-elle encore la ligne endormie et arrêtable ? */
export function stillAsleep(fresh: SwapView | null | undefined, row: SwapRow): boolean {
  const r = fresh?.rows.find((x) => x.key === row.key);
  return !!r && rowAction(r) === 'stop-one';
}

/** Au clic : clés encore proposées par la vue relue (une instance réveillée entre-temps n'est plus proposée). */
export function freshSleepingKeys(fresh: SwapView | null | undefined, keys: readonly string[]): string[] {
  if (!fresh) return [];
  const now = new Set(fresh.sleepingKeys);
  return keys.filter((k) => now.has(k));
}

/** Premier service de session (portail, pipewire, kwallet…) parmi les processus d'un groupe, ou null. */
export function sessionServiceIn(procs: readonly { name: string }[]): string | null {
  return procs.find((p) => isSessionService(p.name))?.name ?? null;
}

/** Saisie du seuil « endormi » (Mo) : entier de 1 à 65 536, comme la validation de la config ; sinon null. */
export function parseSwapSleepMB(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 65_536 ? n : null;
}

/**
 * Champ du seuil dans l'en-tête du panneau, validé à l'Entrée ou à la sortie du champ : valeur valide et différente →
 * enregistrée ; invalide → l'Entrée garde la saisie et montre l'erreur, la sortie du champ revient à la valeur enregistrée.
 */
export function thresholdCommit(raw: string, saved: number, how: 'enter' | 'blur'): { save: number | null; text: string; error: string | null } {
  const n = parseSwapSleepMB(raw);
  if (n === null) return how === 'enter' ? { save: null, text: raw, error: 'Un entier de 1 à 65 536' } : { save: null, text: String(saved), error: null };
  return { save: n === saved ? null : n, text: String(n), error: null };
}
