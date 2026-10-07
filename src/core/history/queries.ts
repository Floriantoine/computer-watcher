// src/core/history/queries.ts
import type { DatabaseSync } from 'node:sqlite';
import type {
  Culprit, GroupHistory, GroupKind, GroupsHistory, HistoryEvent, ProcsHistory, RangePreset, SystemSeries, TimeRange, TopConsumer,
} from '../types';
import { alignSeries } from './series';

const M = 60_000;
const H = 3600_000;
const PRESET_MS: Record<RangePreset, number> = { '1h': H, '6h': 6 * H, '24h': 24 * H, '7d': 7 * 24 * H, '30d': 30 * 24 * H };

export interface QueryOpts {
  now: number;
  detailHours: number;
  intervalSec: number;
}

export const rangeFromPreset = (p: RangePreset, now: number): TimeRange => ({ from: now - PRESET_MS[p], to: now });

export function pickSource(range: TimeRange, now: number, detailHours: number): 'detail' | 'minute' {
  return range.from >= now - detailHours * H && range.to - range.from <= 24 * H ? 'detail' : 'minute';
}

export function bucketMs(range: TimeRange, source: 'detail' | 'minute', intervalSec: number, maxPoints = 1000): number {
  const base = source === 'detail' ? intervalSec * 1000 : M;
  const span = Math.max(1, range.to - range.from);
  return Math.max(base, Math.ceil(span / maxPoints / base) * base);
}

function plan(range: TimeRange, o: QueryOpts) {
  const source = pickSource(range, o.now, o.detailHours);
  return { source, bucket: bucketMs(range, source, o.intervalSec) };
}

export function querySystem(db: DatabaseSync, range: TimeRange, o: QueryOpts): SystemSeries {
  const { source, bucket } = plan(range, o);
  const sql =
    source === 'detail'
      ? `SELECT (ts / ?) * ? AS t, MAX(mem_used_kb) mem, MAX(swap_used_kb) swap, MAX(mem_total_kb) mt, MAX(swap_total_kb) st,
                MAX(psi_some10) psi, MAX(cpu_percent) cpu, MAX(load1) load
         FROM system_samples WHERE ts >= ? AND ts < ? GROUP BY t ORDER BY t`
      : `SELECT (ts / ?) * ? AS t, MAX(mem_used_kb_max) mem, MAX(swap_used_kb_max) swap, MAX(mem_total_kb) mt, MAX(swap_total_kb) st,
                MAX(psi_max) psi, AVG(cpu_avg) cpu, AVG(load1_avg) load
         FROM system_minute WHERE ts >= ? AND ts < ? GROUP BY t ORDER BY t`;
  const rows = db.prepare(sql).all(bucket, bucket, range.from, range.to) as {
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

function groupMeta(db: DatabaseSync, keys: Iterable<string>) {
  const out = new Map<string, { label: string; kind: GroupKind }>();
  const st = db.prepare('SELECT label, kind FROM groups WHERE key = ?');
  for (const k of keys) {
    const r = st.get(k) as { label: string; kind: GroupKind } | undefined;
    if (r) out.set(k, r);
  }
  return out;
}

export function queryGroups(db: DatabaseSync, range: TimeRange, o: QueryOpts, keys?: string[]): GroupsHistory {
  const { source, bucket } = plan(range, o);
  const filter = keys && keys.length ? `AND g.key IN (${keys.map(() => '?').join(',')})` : '';
  const sql =
    source === 'detail'
      ? `SELECT (s.ts / ?) * ? AS t, g.key AS key, MAX(s.rss_kb + s.swap_kb) AS v
         FROM group_samples s JOIN groups g ON g.id = s.group_id WHERE s.ts >= ? AND s.ts < ? ${filter} GROUP BY t, g.key`
      : `SELECT (s.ts / ?) * ? AS t, g.key AS key, MAX(s.mem_kb_max) AS v
         FROM group_minute s JOIN groups g ON g.id = s.group_id WHERE s.ts >= ? AND s.ts < ? ${filter} GROUP BY t, g.key`;
  const rows = db.prepare(sql).all(bucket, bucket, range.from, range.to, ...(keys ?? [])) as { t: number; key: string; v: number }[];
  const { ts, byKey } = alignSeries(rows);
  const meta = groupMeta(db, byKey.keys());
  return {
    ts,
    series: [...byKey].map(([key, memKB]) => ({ key, label: meta.get(key)?.label ?? key, kind: meta.get(key)?.kind ?? 'command', memKB })),
  };
}

export function queryGroup(db: DatabaseSync, key: string, range: TimeRange, o: QueryOpts): GroupHistory {
  const { source, bucket } = plan(range, o);
  const sql =
    source === 'detail'
      ? `SELECT (s.ts / ?) * ? AS t, MAX(s.rss_kb) rss, MAX(s.swap_kb) swap, MAX(s.cpu_percent) cpu
         FROM group_samples s JOIN groups g ON g.id = s.group_id WHERE g.key = ? AND s.ts >= ? AND s.ts < ? GROUP BY t ORDER BY t`
      : `SELECT (s.ts / ?) * ? AS t, MAX(s.rss_kb_avg) rss, MAX(s.swap_kb_avg) swap, AVG(s.cpu_avg) cpu
         FROM group_minute s JOIN groups g ON g.id = s.group_id WHERE g.key = ? AND s.ts >= ? AND s.ts < ? GROUP BY t ORDER BY t`;
  const rows = db.prepare(sql).all(bucket, bucket, key, range.from, range.to) as { t: number; rss: number; swap: number; cpu: number }[];
  return { ts: rows.map((r) => r.t), rssKB: rows.map((r) => r.rss), swapKB: rows.map((r) => r.swap), cpu: rows.map((r) => r.cpu) };
}

export function queryProcs(db: DatabaseSync, groupKey: string, range: TimeRange, o: QueryOpts): ProcsHistory {
  const { source, bucket } = plan(range, o);
  const sql =
    source === 'detail'
      ? `SELECT (s.ts / ?) * ? AS t, p.pid || ':' || p.start_ticks AS key, MAX(s.rss_kb + s.swap_kb) AS v
         FROM proc_samples s JOIN procs p ON p.id = s.proc_id JOIN groups g ON g.id = p.group_id
         WHERE g.key = ? AND s.ts >= ? AND s.ts < ? GROUP BY t, key`
      : `SELECT (s.ts / ?) * ? AS t, p.pid || ':' || p.start_ticks AS key, MAX(s.mem_kb_max) AS v
         FROM proc_minute s JOIN procs p ON p.id = s.proc_id JOIN groups g ON g.id = p.group_id
         WHERE g.key = ? AND s.ts >= ? AND s.ts < ? GROUP BY t, key`;
  const rows = db.prepare(sql).all(bucket, bucket, groupKey, range.from, range.to) as { t: number; key: string; v: number }[];
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
  const source = pickSource(range, o.now, o.detailHours);
  const table = source === 'detail' ? 'group_samples' : 'group_minute';
  const avg = source === 'detail' ? 'AVG(s.rss_kb + s.swap_kb)' : 'AVG(s.rss_kb_avg + s.swap_kb_avg)';
  const max = source === 'detail' ? 'MAX(s.rss_kb + s.swap_kb)' : 'MAX(s.mem_kb_max)';
  const rows = db
    .prepare(
      `SELECT g.key, g.label, g.kind, ${avg} AS avg, ${max} AS max FROM ${table} s JOIN groups g ON g.id = s.group_id
       WHERE s.ts >= ? AND s.ts < ? GROUP BY g.id ORDER BY avg DESC LIMIT ?`,
    )
    .all(range.from, range.to, limit) as { key: string; label: string; kind: GroupKind; avg: number; max: number }[];
  if (rows.length === 0) return [];
  const spark = queryGroups(db, range, { ...o, intervalSec: o.intervalSec }, rows.map((r) => r.key));
  // Les mini-courbes du top sont ramenées à ~60 points.
  const step = Math.max(1, Math.ceil(spark.ts.length / 60));
  const thin = (s: (number | null)[]) => s.filter((_, i) => i % step === 0).map((v) => v ?? 0);
  const byKey = new Map(spark.series.map((s) => [s.key, s.memKB]));
  return rows.map((r) => ({ key: r.key, label: r.label, kind: r.kind, avgKB: Math.round(r.avg), maxKB: r.max, spark: thin(byKey.get(r.key) ?? []) }));
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
