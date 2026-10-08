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

/** Alertes de `ts > since`, les `limit` plus récentes d'abord (index events_ts). */
export function queryUnseenAlerts(db: DatabaseSync, since: number, limit = 100): AlertEvent[] {
  const rows = db.prepare(`${SELECT} WHERE e.ts > ? AND e.type IN (${TYPES}) ORDER BY e.ts DESC, e.id DESC LIMIT ?`).all(since, limit) as unknown as Row[];
  return rows.map(toAlert);
}

export function queryAlert(db: DatabaseSync, id: number): AlertEvent | null {
  const r = db.prepare(`${SELECT} WHERE e.id = ? AND e.type IN (${TYPES})`).get(id) as unknown as Row | undefined;
  return r ? toAlert(r) : null;
}
