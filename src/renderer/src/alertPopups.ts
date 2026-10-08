// Pop-ups d'alerte (logique pure) : lesquels montrer, empilement, « vu jusqu'à » après fermeture, action contextuelle.
import type { AlertEvent, AlertsConfig } from '../../core/alerts';

export const MAX_VISIBLE = 3;

const shown = (e: AlertEvent, cfg: AlertsConfig) => (cfg.channels[e.type] ?? 'popup') !== 'none';

/** Réponse de `alerts:unseen` : les 100 plus récentes et le nombre total. */
export interface Unseen { total: number; alerts: AlertEvent[] }

/** Alertes à montrer : après `seenUpTo`, canal pop-up, pas encore fermées (config ou session) ; les plus récentes d'abord. */
export function pendingPopups(events: readonly AlertEvent[] | undefined, cfg: AlertsConfig, dismissed: ReadonlySet<number>): AlertEvent[] {
  const seen = new Set(cfg.seenIds);
  return (events ?? [])
    .filter((e) => e.ts > cfg.seenUpTo && shown(e, cfg) && !dismissed.has(e.id) && !seen.has(e.id))
    .sort((a, b) => b.ts - a.ts || b.id - a.id);
}

export function popupStack(pending: readonly AlertEvent[], max = MAX_VISIBLE): { visible: AlertEvent[]; more: number } {
  return { visible: pending.slice(0, max), more: Math.max(0, pending.length - max) };
}

/**
 * Nouveau `seenUpTo` après fermeture : avance, de la plus ancienne à la plus récente, tant que toutes les alertes d'un même
 * instant sont fermées (ou sans pop-up). Une alerte récente fermée avant les anciennes reste masquée par `dismissed`.
 */
export function seenAfterClose(events: readonly AlertEvent[], cfg: AlertsConfig, dismissed: ReadonlySet<number>): number {
  const byTs = new Map<number, AlertEvent[]>();
  for (const e of events) if (e.ts > cfg.seenUpTo) byTs.set(e.ts, [...(byTs.get(e.ts) ?? []), e]);
  let seen = cfg.seenUpTo;
  const closed = new Set(cfg.seenIds);
  for (const ts of [...byTs.keys()].sort((a, b) => a - b)) {
    if (!byTs.get(ts)!.every((e) => dismissed.has(e.id) || closed.has(e.id) || !shown(e, cfg))) break;
    seen = ts;
  }
  return seen;
}

/** Badge : total compté par SQL (sans plafond), moins les fermetures de la session pas encore prises en compte. */
export function badgeCount(total: number, loaded: readonly AlertEvent[], dismissed: ReadonlySet<number>): number {
  return Math.max(0, total - loaded.filter((e) => dismissed.has(e.id)).length);
}

/** Même réponse (total, ids dans le même ordre) : on garde l'ancienne référence, aucun rendu. */
export function sameUnseen(a: Unseen | undefined, b: Unseen): boolean {
  return !!a && a.total === b.total && a.alerts.length === b.alerts.length && a.alerts.every((e, i) => e.id === b.alerts[i]!.id);
}

export type PopupAction =
  | { kind: 'tmp'; label: string }
  | { kind: 'group'; label: string; groupKey: string }
  | { kind: 'instant'; label: string; ts: number };

export function popupAction(e: AlertEvent, groupPresent: (key: string) => boolean): PopupAction {
  if (e.type === 'tmpfs') return { kind: 'tmp', label: 'Voir /tmp' };
  if (e.groupKey && groupPresent(e.groupKey)) return { kind: 'group', label: 'Voir le groupe', groupKey: e.groupKey };
  return { kind: 'instant', label: 'Voir l’instant', ts: e.ts };
}
