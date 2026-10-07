// src/core/history/queries.ts
import type { DatabaseSync } from 'node:sqlite';
import type {
  Culprit, GroupHistory, GroupKind, GroupsHistory, HistoryEvent, ProcsHistory, RangePreset, SystemSeries, TimeRange, TopConsumer,
} from '../types';
import { alignSeries } from './series';

const M = 60_000;
const H = 3600_000;
const DETAIL_MAX_BUCKET = 15_000;
const I = 'CAST(? AS INTEGER)';
// node:sqlite lie les nombres JS en REAL : la division du bucket doit être castée en entier.
const PRESET_MS: Record<RangePreset, number> = { '1h': H, '6h': 6 * H, '24h': 24 * H, '7d': 7 * 24 * H, '30d': 30 * 24 * H };

export interface QueryOpts {
  now: number;
  detailHours: number;
  intervalSec: number;
}

export const rangeFromPreset = (p: RangePreset, now: number): TimeRange => ({ from: now - PRESET_MS[p], to: now });

export function pickSource(range: TimeRange, now: number, detailHours: number, intervalSec = 5): 'detail' | 'minute' {
  if (range.from < now - detailHours * H || range.to - range.from > 24 * H) return 'minute';
  // Dès que le bucket détaillé atteint 15 s, les agrégats par minute donnent un rendu quasi identique avec bien moins de lignes.
  return bucketMs(range, 'detail', intervalSec) >= DETAIL_MAX_BUCKET ? 'minute' : 'detail';
}

export function bucketMs(range: TimeRange, source: 'detail' | 'minute', intervalSec: number, maxPoints = 1000): number {
  const base = source === 'detail' ? intervalSec * 1000 : M;
  const span = Math.max(1, range.to - range.from);
  return Math.max(base, Math.ceil(span / maxPoints / base) * base);
}

function plan(range: TimeRange, o: QueryOpts) {
  const source = pickSource(range, o.now, o.detailHours, o.intervalSec);
  return { source, bucket: bucketMs(range, source, o.intervalSec) };
}

export function querySystem(db: DatabaseSync, range: TimeRange, o: QueryOpts): SystemSeries {
  const { source, bucket } = plan(range, o);
  const sql =
    source === 'detail'
      ? `SELECT (CAST(? AS INTEGER) + ((ts - CAST(? AS INTEGER)) / CAST(? AS INTEGER)) * CAST(? AS INTEGER)) AS t, MAX(mem_used_kb) mem, MAX(swap_used_kb) swap, MAX(mem_total_kb) mt, MAX(swap_total_kb) st,
                MAX(psi_some10) psi, MAX(cpu_percent) cpu, MAX(load1) load
         FROM system_samples WHERE ts >= ? AND ts < ? GROUP BY t ORDER BY t`
      : `SELECT (CAST(? AS INTEGER) + ((ts - CAST(? AS INTEGER)) / CAST(? AS INTEGER)) * CAST(? AS INTEGER)) AS t, MAX(mem_used_kb_max) mem, MAX(swap_used_kb_max) swap, MAX(mem_total_kb) mt, MAX(swap_total_kb) st,
                MAX(psi_max) psi, AVG(cpu_avg) cpu, AVG(load1_avg) load
         FROM system_minute WHERE ts >= ? AND ts < ? GROUP BY t ORDER BY t`;
  const rows = db.prepare(sql).all(range.from, range.from, bucket, bucket, range.from, range.to) as {
    t: number; mem: number; swap: number; mt: number; st: number; psi: number | null; cpu: number; load: number;
  }[];
  return {
    ts: rows.map((r) => r.t),
    memUsedKB: rows.map((r) => r.mem),
    swapUsedKB: rows.map((r) => r.swap),
    memTotalKB: Math.max(0, ...rows.map((r) => r.mt)),
    swapTotalKB: Math.max(0, ...rows.map((r) => r.st)),
    psi: rows.map((r) => r.psi),
    cpu: rows.map((r) => r.cpu),
    load: rows.map((r) => r.load),
  };
}

interface GroupMeta { id: number; key: string; label: string; kind: GroupKind }

/**
 * Agrège par group_id, une requête par groupe : chaque requête est un parcours ordonné de la clé primaire
 * (group_id, ts), sans B-tree temporaire ni jointure ; ~2x plus rapide qu'un GROUP BY global sur 100 groupes.
 */
function groupRows(db: DatabaseSync, source: 'detail' | 'minute', bucket: number, range: TimeRange, ids: number[] | null) {
  const table = source === 'detail' ? 'group_samples' : 'group_minute';
  const v = source === 'detail' ? 'MAX(rss_kb + swap_kb)' : 'MAX(mem_kb_max)';
  const gids = ids ?? (db.prepare('SELECT id FROM groups').all() as { id: number }[]).map((r) => r.id);
  const st = db.prepare(
    `SELECT (${I} + ((ts - ${I}) / ${I}) * ${I}) AS t, ${v} AS v FROM ${table} WHERE group_id = ? AND ts >= ? AND ts < ? GROUP BY t`,
  );
  st.setReturnArrays(true);
  const out: { t: number; gid: number; v: number }[] = [];
  for (const gid of gids) {
    for (const [t, val] of st.all(range.from, range.from, bucket, bucket, gid, range.from, range.to) as unknown as [number, number][]) {
      out.push({ t, gid, v: val });
    }
  }
  return out;
}

function groupsHistory(db: DatabaseSync, source: 'detail' | 'minute', bucket: number, range: TimeRange, metas: GroupMeta[] | null): GroupsHistory {
  const rows = groupRows(db, source, bucket, range, metas ? metas.map((m) => m.id) : null);
  const { ts, byKey } = alignSeries(rows.map((r) => ({ t: r.t, key: String(r.gid), v: r.v })));
  const meta = metas ?? (db.prepare('SELECT id, key, label, kind FROM groups').all() as unknown as GroupMeta[]);
  const byId = new Map(meta.map((m) => [String(m.id), m]));
  return {
    ts,
    series: [...byKey].flatMap(([gid, memKB]) => {
      const m = byId.get(gid);
      return m ? [{ key: m.key, label: m.label, kind: m.kind, memKB }] : [];
    }),
  };
}

export function queryGroups(db: DatabaseSync, range: TimeRange, o: QueryOpts, keys?: string[]): GroupsHistory {
  const { source, bucket } = plan(range, o);
  let metas: GroupMeta[] | null = null;
  if (keys && keys.length) {
    metas = db
      .prepare(`SELECT id, key, label, kind FROM groups WHERE key IN (${keys.map(() => '?').join(',')})`)
      .all(...keys) as unknown as GroupMeta[];
    if (metas.length === 0) return { ts: [], series: [] };
  }
  return groupsHistory(db, source, bucket, range, metas);
}

export function queryGroup(db: DatabaseSync, key: string, range: TimeRange, o: QueryOpts): GroupHistory {
  const { source, bucket } = plan(range, o);
  const sql =
    source === 'detail'
      ? `SELECT (CAST(? AS INTEGER) + ((s.ts - CAST(? AS INTEGER)) / CAST(? AS INTEGER)) * CAST(? AS INTEGER)) AS t, MAX(s.rss_kb) rss, MAX(s.swap_kb) swap, MAX(s.cpu_percent) cpu
         FROM group_samples s JOIN groups g ON g.id = s.group_id WHERE g.key = ? AND s.ts >= ? AND s.ts < ? GROUP BY t ORDER BY t`
      : `SELECT (CAST(? AS INTEGER) + ((s.ts - CAST(? AS INTEGER)) / CAST(? AS INTEGER)) * CAST(? AS INTEGER)) AS t, MAX(s.rss_kb_avg) rss, MAX(s.swap_kb_avg) swap, AVG(s.cpu_avg) cpu
         FROM group_minute s JOIN groups g ON g.id = s.group_id WHERE g.key = ? AND s.ts >= ? AND s.ts < ? GROUP BY t ORDER BY t`;
  const rows = db.prepare(sql).all(range.from, range.from, bucket, bucket, key, range.from, range.to) as { t: number; rss: number; swap: number; cpu: number }[];
  return { ts: rows.map((r) => r.t), rssKB: rows.map((r) => r.rss), swapKB: rows.map((r) => r.swap), cpu: rows.map((r) => r.cpu) };
}

export function queryProcs(db: DatabaseSync, groupKey: string, range: TimeRange, o: QueryOpts): ProcsHistory {
  const { source, bucket } = plan(range, o);
  // GROUP BY p.id et non par l'alias `key` : dans un GROUP BY, `key` désignerait la colonne groups.key.
  const sql =
    source === 'detail'
      ? `SELECT (CAST(? AS INTEGER) + ((s.ts - CAST(? AS INTEGER)) / CAST(? AS INTEGER)) * CAST(? AS INTEGER)) AS t, p.pid || ':' || p.start_ticks AS key, MAX(s.rss_kb + s.swap_kb) AS v
         FROM proc_samples s JOIN procs p ON p.id = s.proc_id JOIN groups g ON g.id = p.group_id
         WHERE g.key = ? AND s.ts >= ? AND s.ts < ? GROUP BY t, p.id`
      : `SELECT (CAST(? AS INTEGER) + ((s.ts - CAST(? AS INTEGER)) / CAST(? AS INTEGER)) * CAST(? AS INTEGER)) AS t, p.pid || ':' || p.start_ticks AS key, MAX(s.mem_kb_max) AS v
         FROM proc_minute s JOIN procs p ON p.id = s.proc_id JOIN groups g ON g.id = p.group_id
         WHERE g.key = ? AND s.ts >= ? AND s.ts < ? GROUP BY t, p.id`;
  const rows = db.prepare(sql).all(range.from, range.from, bucket, bucket, groupKey, range.from, range.to) as { t: number; key: string; v: number }[];
  const { ts, byKey } = alignSeries(rows);
  return {
    ts,
    series: [...byKey].map(([key, memKB]) => {
      const [pid, startTicks] = key.split(':').map(Number);
      return { pid, startTicks, memKB };
    }),
  };
}

export function queryCulprits(db: DatabaseSync, ts: number, o: QueryOpts, windowMin = 5, limit = 10): Culprit[] {
  const from = ts - windowMin * M;
  const detail = from >= o.now - o.detailHours * H;
  const table = detail ? 'group_samples' : 'group_minute';
  const mem = detail ? 's.rss_kb + s.swap_kb' : 's.rss_kb_avg + s.swap_kb_avg';
  const rows = db
    .prepare(
      `WITH w AS (SELECT s.group_id, s.ts, ${mem} AS mem FROM ${table} s WHERE s.ts >= ? AND s.ts <= ?),
            first AS (SELECT group_id, mem FROM w WHERE (group_id, ts) IN (SELECT group_id, MIN(ts) FROM w GROUP BY group_id)),
            last AS (SELECT group_id, mem FROM w WHERE (group_id, ts) IN (SELECT group_id, MAX(ts) FROM w GROUP BY group_id))
       SELECT g.key, g.label, g.kind, last.mem - first.mem AS delta, last.mem AS mem
       FROM last JOIN first USING (group_id) JOIN groups g ON g.id = last.group_id
       ORDER BY delta DESC LIMIT ?`,
    )
    .all(from, ts, limit) as { key: string; label: string; kind: GroupKind; delta: number; mem: number }[];
  return rows.map((r) => ({ key: r.key, label: r.label, kind: r.kind, deltaKB: Math.round(r.delta), memKB: Math.round(r.mem) }));
}

export function queryTop(db: DatabaseSync, range: TimeRange, o: QueryOpts, limit = 10): TopConsumer[] {
  const { source, bucket } = plan(range, o);
  const table = source === 'detail' ? 'group_samples' : 'group_minute';
  const avg = source === 'detail' ? 'AVG(rss_kb + swap_kb)' : 'AVG(rss_kb_avg + swap_kb_avg)';
  const max = source === 'detail' ? 'MAX(rss_kb + swap_kb)' : 'MAX(mem_kb_max)';
  const top = db
    .prepare(`SELECT group_id AS gid, ${avg} AS avg, ${max} AS max FROM ${table} WHERE ts >= ? AND ts < ? GROUP BY group_id ORDER BY avg DESC LIMIT ?`)
    .all(range.from, range.to, limit) as { gid: number; avg: number; max: number }[];
  if (top.length === 0) return [];
  const metas = db
    .prepare(`SELECT id, key, label, kind FROM groups WHERE id IN (${top.map(() => '?').join(',')})`)
    .all(...top.map((t) => t.gid)) as unknown as GroupMeta[];
  const spark = groupsHistory(db, source, bucket, range, metas);
  // Les mini-courbes du top sont ramenées à ~60 points.
  const step = Math.max(1, Math.ceil(spark.ts.length / 60));
  const thin = (s: (number | null)[]) => s.filter((_, i) => i % step === 0).map((v) => v ?? 0);
  const sparkByKey = new Map(spark.series.map((s) => [s.key, s.memKB]));
  const metaById = new Map(metas.map((m) => [m.id, m]));
  return top.flatMap((r) => {
    const m = metaById.get(r.gid);
    return m ? [{ key: m.key, label: m.label, kind: m.kind, avgKB: Math.round(r.avg), maxKB: r.max, spark: thin(sparkByKey.get(m.key) ?? []) }] : [];
  });
}

export function queryEvents(db: DatabaseSync, range: TimeRange): HistoryEvent[] {
  const rows = db
    .prepare(
      `SELECT e.ts, e.type, g.key AS gk, g.label AS gl, e.detail FROM events e LEFT JOIN groups g ON g.id = e.group_id
       WHERE e.ts >= ? AND e.ts < ? ORDER BY e.ts`,
    )
    .all(range.from, range.to) as { ts: number; type: string; gk: string | null; gl: string | null; detail: string }[];
  return rows.map((r) => ({ ts: r.ts, type: r.type, groupKey: r.gk, groupLabel: r.gl, detail: JSON.parse(r.detail) as Record<string, unknown> }));
}
