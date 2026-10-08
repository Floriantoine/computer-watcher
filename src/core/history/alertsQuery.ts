// src/core/history/alertsQuery.ts — alertes non vues (pop-ups) et alerte par id (`--alert=<id>`), en lecture seule.
import type { DatabaseSync } from 'node:sqlite';
import { ALERT_TYPES, type AlertEvent } from '../alerts';

const TYPES = ALERT_TYPES.map((t) => `'${t}'`).join(', ');
const SELECT = `SELECT e.id, e.ts, e.type, g.key AS gk, g.label AS gl, e.detail FROM events e LEFT JOIN groups g ON g.id = e.group_id`;

interface Row { id: number; ts: number; type: string; gk: string | null; gl: string | null; detail: string }

function toAlert(r: Row): AlertEvent {
  let detail: Record<string, unknown> = {};
  try {
    const d = JSON.parse(r.detail) as unknown;
    if (d && typeof d === 'object' && !Array.isArray(d)) detail = d as Record<string, unknown>;
  } catch {
    // détail illisible : alerte gardée, texte générique
  }
  return { id: r.id, ts: r.ts, type: r.type as AlertEvent['type'], groupKey: r.gk, groupLabel: r.gl, detail };
}

/** Types d'alerte à montrer (canal pop-up) et ids déjà fermés. */
export interface UnseenFilter { types: readonly string[]; exclude: readonly number[] }

const WHERE = `e.ts > ? AND e.type IN (SELECT value FROM json_each(?)) AND e.id NOT IN (SELECT value FROM json_each(?))`;
const params = (since: number, f: UnseenFilter) => [since, JSON.stringify(f.types), JSON.stringify(f.exclude)] as const;

/** Alertes non vues, les `limit` plus récentes d'abord (index events_ts). */
export function queryUnseenAlerts(db: DatabaseSync, since: number, f: UnseenFilter & { limit?: number }): AlertEvent[] {
  const rows = db.prepare(`${SELECT} WHERE ${WHERE} ORDER BY e.ts DESC, e.id DESC LIMIT ?`).all(...params(since, f), f.limit ?? 100) as unknown as Row[];
  return rows.map(toAlert);
}

/** Nombre d'alertes non vues (badge), sans limite. */
export function countUnseenAlerts(db: DatabaseSync, since: number, f: UnseenFilter): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM events e WHERE ${WHERE}`).get(...params(since, f)) as { n: number }).n;
}

/** Instant de l'alerte non vue la plus récente (« Tout fermer »), ou null. */
export function newestAlertTs(db: DatabaseSync, since: number, f: UnseenFilter): number | null {
  return (db.prepare(`SELECT MAX(e.ts) AS ts FROM events e WHERE ${WHERE}`).get(...params(since, f)) as { ts: number | null }).ts;
}

/** Instant de chaque alerte (ids absents de la base omis). */
export function queryAlertTimes(db: DatabaseSync, ids: readonly number[]): Map<number, number> {
  if (!ids.length) return new Map();
  const rows = db.prepare(`SELECT id, ts FROM events WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as { id: number; ts: number }[];
  return new Map(rows.map((r) => [r.id, r.ts]));
}

export function queryAlert(db: DatabaseSync, id: number): AlertEvent | null {
  const r = db.prepare(`${SELECT} WHERE e.id = ? AND e.type IN (${TYPES})`).get(id) as unknown as Row | undefined;
  return r ? toAlert(r) : null;
}
