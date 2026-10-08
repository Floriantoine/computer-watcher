// Pop-ups d'alerte (logique pure) : lesquels montrer, empilement, « vu jusqu'à » après fermeture, action contextuelle.
import type { AlertEvent, AlertsConfig } from '../../core/alerts';

export const MAX_VISIBLE = 3;

const shown = (e: AlertEvent, cfg: AlertsConfig) => (cfg.channels[e.type] ?? 'popup') !== 'none';

/** Alertes à montrer : après `seenUpTo`, canal pop-up, pas encore fermées ; les plus récentes d'abord. */
export function pendingPopups(events: readonly AlertEvent[] | undefined, cfg: AlertsConfig, dismissed: ReadonlySet<number>): AlertEvent[] {
  return (events ?? [])
    .filter((e) => e.ts > cfg.seenUpTo && shown(e, cfg) && !dismissed.has(e.id))
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
  for (const ts of [...byTs.keys()].sort((a, b) => a - b)) {
    if (!byTs.get(ts)!.every((e) => dismissed.has(e.id) || !shown(e, cfg))) break;
    seen = ts;
  }
  return seen;
}

/** « Tout fermer » : vues jusqu'à la plus récente. */
export function seenAfterCloseAll(events: readonly AlertEvent[], cfg: AlertsConfig): number {
  return events.reduce((m, e) => Math.max(m, e.ts), cfg.seenUpTo);
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
