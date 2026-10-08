// src/core/history/queries.ts
import type { DatabaseSync } from 'node:sqlite';
import type {
  Culprit, GroupHistory, GroupKind, GroupsHistory, HistoryEvent, ProcsHistory, ProcTreeAt, ProcTreeRow, RangePreset, SystemSeries, TimeRange, TopConsumer, TopOptions, TopResult,
} from '../types';
import { hasColumn } from './db';
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

export type Source = 'detail' | 'minute' | 'hour';
/** Au-delà de 48 h, les tables horaires : ≤ 720 lignes par groupe pour 30 jours au lieu de 43 200. */
const HOUR_SOURCE_MIN_SPAN = 48 * H;

export function pickSource(range: TimeRange, now: number, detailHours: number, intervalSec = 5): Source {
  if (range.to - range.from > HOUR_SOURCE_MIN_SPAN || bucketMs(range, 'minute', intervalSec) >= H) return 'hour';
  if (range.from < now - detailHours * H || range.to - range.from > 24 * H) return 'minute';
  // Dès que le bucket détaillé atteint 15 s, les agrégats par minute donnent un rendu quasi identique avec bien moins de lignes.
  return bucketMs(range, 'detail', intervalSec) >= DETAIL_MAX_BUCKET ? 'minute' : 'detail';
}

export function bucketMs(range: TimeRange, source: Source, intervalSec: number, maxPoints = 1000): number {
  const base = source === 'detail' ? intervalSec * 1000 : source === 'minute' ? M : H;
  const span = Math.max(1, range.to - range.from);
  return Math.max(base, Math.ceil(span / maxPoints / base) * base);
}

const hasTable = (db: DatabaseSync, name: string) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

function plan(db: DatabaseSync, range: TimeRange, o: QueryOpts) {
  let source = pickSource(range, o.now, o.detailHours, o.intervalSec);
  // base v2 pas encore migrée par le service (lecture seule) : pas de tables horaires
  if (source === 'hour' && !hasTable(db, 'group_hour')) source = 'minute';
  return { source, bucket: bucketMs(range, source, o.intervalSec) };
}

const SYSTEM_TABLE: Record<Source, string> = { detail: 'system_samples', minute: 'system_minute', hour: 'system_hour' };
const GROUP_TABLE: Record<Source, string> = { detail: 'group_samples', minute: 'group_minute', hour: 'group_hour' };

const SHMEM_COLUMN: Record<Source, string> = { detail: 'shmem_kb', minute: 'shmem_kb_max', hour: 'shmem_kb_max' };

export function querySystem(db: DatabaseSync, range: TimeRange, o: QueryOpts): SystemSeries {
  const { source, bucket } = plan(db, range, o);
  // base v3 (lecture seule, pas encore migrée par le service) : pas de colonnes shmem → null
  const shmem = hasColumn(db, SYSTEM_TABLE[source], SHMEM_COLUMN[source]) ? `MAX(${SHMEM_COLUMN[source]})` : 'NULL';
  const sql =
    source === 'detail'
      ? `SELECT (CAST(? AS INTEGER) + ((ts - CAST(? AS INTEGER)) / CAST(? AS INTEGER)) * CAST(? AS INTEGER)) AS t, MAX(mem_used_kb) mem, MAX(swap_used_kb) swap, MAX(mem_total_kb) mt, MAX(swap_total_kb) st,
                MAX(psi_some10) psi, MAX(cpu_percent) cpu, MAX(load1) load, ${shmem} shmem
         FROM system_samples WHERE ts >= ? AND ts < ? GROUP BY t ORDER BY t`
      : `SELECT (CAST(? AS INTEGER) + ((ts - CAST(? AS INTEGER)) / CAST(? AS INTEGER)) * CAST(? AS INTEGER)) AS t, MAX(mem_used_kb_max) mem, MAX(swap_used_kb_max) swap, MAX(mem_total_kb) mt, MAX(swap_total_kb) st,
                MAX(psi_max) psi, AVG(cpu_avg) cpu, AVG(load1_avg) load, ${shmem} shmem
         FROM ${SYSTEM_TABLE[source]} WHERE ts >= ? AND ts < ? GROUP BY t ORDER BY t`;
  const rows = db.prepare(sql).all(range.from, range.from, bucket, bucket, range.from, range.to) as {
    t: number; mem: number; swap: number; mt: number; st: number; psi: number | null; cpu: number; load: number; shmem: number | null;
  }[];
  const groups = groupsTotal(db, source, bucket, range);
  return {
    ts: rows.map((r) => r.t),
    memUsedKB: rows.map((r) => r.mem),
    swapUsedKB: rows.map((r) => r.swap),
    memTotalKB: Math.max(0, ...rows.map((r) => r.mt)),
    swapTotalKB: Math.max(0, ...rows.map((r) => r.st)),
    psi: rows.map((r) => r.psi),
    cpu: rows.map((r) => r.cpu),
    load: rows.map((r) => r.load),
    shmemKB: rows.map((r) => r.shmem),
    groupsKB: rows.map((r) => groups.get(r.t) ?? null),
  };
}

/** Pas natif des tables agrégées : un bucket au moins aussi long contient au plus une ligne par groupe et par pas. */
const NATIVE_STEP: Record<Source, number> = { detail: 0, minute: M, hour: H };

/**
 * Somme, par bucket, du pic de chaque groupe (même valeur que les courbes de groupes), indexée par début de bucket.
 * - détail : pic par (groupe, bucket) puis somme ;
 * - bucket égal au pas de la table (30 j sur les heures) : une ligne par groupe et par bucket, la somme directe suffit ;
 *   sur les heures, `+ts` parcourt la table dans l'ordre de la clé (comme queryTop) au lieu d'une recherche par ligne ;
 * - sinon : un parcours de clé primaire par groupe (`groupRows`), somme en JS.
 */
function groupsTotal(db: DatabaseSync, source: Source, bucket: number, range: TimeRange): Map<number, number> {
  const out = new Map<number, number>();
  const t = `(${I} + ((ts - ${I}) / ${I}) * ${I})`;
  let sql: string;
  if (source === 'detail') {
    sql = `SELECT t, SUM(v) AS v FROM (
             SELECT ${t} AS t, MAX(rss_kb + swap_kb) AS v FROM group_samples WHERE ts >= ? AND ts < ? GROUP BY group_id, t
           ) GROUP BY t`;
  } else if (bucket === NATIVE_STEP[source]) {
    const tsCol = source === 'hour' ? '+ts' : 'ts';
    sql = `SELECT ${t} AS t, SUM(mem_kb_max) AS v FROM ${GROUP_TABLE[source]} WHERE ${tsCol} >= ? AND ${tsCol} < ? GROUP BY t`;
  } else {
    for (const r of groupRows(db, source, bucket, range, null)) out.set(r.t, (out.get(r.t) ?? 0) + r.v);
    return out;
  }
  const st = db.prepare(sql);
  st.setReturnArrays(true);
  for (const [k, v] of st.all(range.from, range.from, bucket, bucket, range.from, range.to) as unknown as [number, number][]) out.set(k, v);
  return out;
}

interface GroupMeta { id: number; key: string; label: string; kind: GroupKind }

/**
 * Agrège par group_id, une requête par groupe : chaque requête est un parcours ordonné de la clé primaire
 * (group_id, ts), sans B-tree temporaire ni jointure ; ~2x plus rapide qu'un GROUP BY global sur 100 groupes.
 */
function groupRows(db: DatabaseSync, source: Source, bucket: number, range: TimeRange, ids: number[] | null) {
  const table = GROUP_TABLE[source];
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

function groupsHistory(db: DatabaseSync, source: Source, bucket: number, range: TimeRange, metas: GroupMeta[] | null): GroupsHistory {
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
  const { source, bucket } = plan(db, range, o);
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
  const { source, bucket } = plan(db, range, o);
  const sql =
    source === 'detail'
      ? `SELECT (CAST(? AS INTEGER) + ((s.ts - CAST(? AS INTEGER)) / CAST(? AS INTEGER)) * CAST(? AS INTEGER)) AS t, MAX(s.rss_kb) rss, MAX(s.swap_kb) swap, MAX(s.cpu_percent) cpu
         FROM group_samples s JOIN groups g ON g.id = s.group_id WHERE g.key = ? AND s.ts >= ? AND s.ts < ? GROUP BY t ORDER BY t`
      : `SELECT (CAST(? AS INTEGER) + ((s.ts - CAST(? AS INTEGER)) / CAST(? AS INTEGER)) * CAST(? AS INTEGER)) AS t, MAX(s.rss_kb_avg) rss, MAX(s.swap_kb_avg) swap, AVG(s.cpu_avg) cpu
         FROM ${GROUP_TABLE[source]} s JOIN groups g ON g.id = s.group_id WHERE g.key = ? AND s.ts >= ? AND s.ts < ? GROUP BY t ORDER BY t`;
  const rows = db.prepare(sql).all(range.from, range.from, bucket, bucket, key, range.from, range.to) as { t: number; rss: number; swap: number; cpu: number }[];
  return { ts: rows.map((r) => r.t), rssKB: rows.map((r) => r.rss), swapKB: rows.map((r) => r.swap), cpu: rows.map((r) => r.cpu) };
}

export function queryProcs(db: DatabaseSync, groupKey: string, range: TimeRange, o: QueryOpts): ProcsHistory {
  const { source, bucket } = plan(db, range, o);
  // GROUP BY p.id et non par l'alias `key` : dans un GROUP BY, `key` désignerait la colonne groups.key.
  // Pas de table horaire par processus : au-delà de 48 h, proc_minute avec des buckets d'une heure (un seul groupe).
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
            first AS (SELECT group_id, ts, mem FROM w WHERE (group_id, ts) IN (SELECT group_id, MIN(ts) FROM w GROUP BY group_id)),
            last AS (SELECT group_id, mem FROM w WHERE (group_id, ts) IN (SELECT group_id, MAX(ts) FROM w GROUP BY group_id))
       SELECT g.key, g.label, g.kind, last.mem AS mem, last.mem - first.mem AS delta, first.ts AS firstTs
       FROM last JOIN first USING (group_id) JOIN groups g ON g.id = last.group_id`,
    )
    .all(from, ts) as { key: string; label: string; kind: GroupKind; delta: number; mem: number; firstTs: number }[];
  // Les petits groupes sont repliés dans « Petits groupes » : un groupe sans ligne au début de la fenêtre y est « apparu »
  // (franchissement du seuil) ; sa mémoire de départ n'est pas 0 mais inconnue, on retient sa mémoire au dernier point.
  // Seulement si le service échantillonnait déjà au début de la fenêtre (sinon trou, redémarrage : rien ne prouve l'apparition).
  const sampled = db
    .prepare(
      detail
        ? 'SELECT MIN(t) AS t FROM (SELECT MIN(ts) AS t FROM system_samples WHERE ts >= ? AND ts <= ? UNION ALL SELECT MIN(ts) FROM group_samples WHERE ts >= ? AND ts <= ?)'
        : 'SELECT MIN(ts) AS t FROM system_minute WHERE ts >= ? AND ts <= ?',
    )
    .get(...(detail ? [from, ts, from, ts] : [from, ts])) as { t: number | null };
  const appearedAfter = Math.max(from, sampled.t ?? from) + (detail ? 2 * o.intervalSec * 1000 : 2 * M);
  return rows
    .map((r) => ({ key: r.key, label: r.label, kind: r.kind, deltaKB: Math.round(r.firstTs > appearedAfter ? r.mem : r.delta), memKB: Math.round(r.mem) }))
    .sort((a, b) => b.deltaKB - a.deltaKB)
    .slice(0, limit);
}

/**
 * Top des groupes sur la plage, en un seul parcours GROUP BY : `byAvg` (par moyenne, avec mini-courbes, `limit`)
 * et `byMax` (par pic, sans mini-courbes, `peakLimit`).
 */
export function queryTop(db: DatabaseSync, range: TimeRange, o: QueryOpts, { limit = 10, peakLimit = 8 }: TopOptions = {}): TopResult {
  const { source, bucket } = plan(db, range, o);
  const table = GROUP_TABLE[source];
  const avg = source === 'detail' ? 'AVG(rss_kb + swap_kb)' : 'AVG(rss_kb_avg + swap_kb_avg)';
  // Par minute/heure, mem_kb_max garde le pic : un pic court survit aux plages de 7 j / 30 j.
  const max = source === 'detail' ? 'MAX(rss_kb + swap_kb)' : 'MAX(mem_kb_max)';
  // Tables horaires : la plage couvre une grande part de la table ; `+ts` écarte l'index sur ts au profit d'un parcours
  // dans l'ordre de la clé (group_id, ts), déjà groupé : pas de lookup par ligne ni de B-tree temporaire (~4x plus rapide à 30 j).
  const tsCol = source === 'hour' ? '+ts' : 'ts';
  const all = db
    .prepare(`SELECT group_id AS gid, ${avg} AS avg, ${max} AS max FROM ${table} WHERE ${tsCol} >= ? AND ${tsCol} < ? GROUP BY group_id`)
    .all(range.from, range.to) as { gid: number; avg: number; max: number }[];
  if (all.length === 0) return { byAvg: [], byMax: [] };
  const byAvgRows = [...all].sort((a, b) => b.avg - a.avg).slice(0, limit);
  const byMaxRows = [...all].sort((a, b) => b.max - a.max).slice(0, peakLimit);
  const ids = [...new Set([...byAvgRows, ...byMaxRows].map((r) => r.gid))];
  const metas = db
    .prepare(`SELECT id, key, label, kind FROM groups WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as unknown as GroupMeta[];
  const metaById = new Map(metas.map((m) => [m.id, m]));
  const avgMetas = byAvgRows.flatMap((r) => metaById.get(r.gid) ?? []);
  const spark = groupsHistory(db, source, bucket, range, avgMetas);
  // Les mini-courbes du top sont ramenées à ~60 points.
  const step = Math.max(1, Math.ceil(spark.ts.length / 60));
  const thin = (s: (number | null)[]) => s.filter((_, i) => i % step === 0).map((v) => v ?? 0);
  const sparkByKey = new Map(spark.series.map((s) => [s.key, s.memKB]));
  const toConsumer = (r: { gid: number; avg: number; max: number }, withSpark: boolean): TopConsumer[] => {
    const m = metaById.get(r.gid);
    return m ? [{ key: m.key, label: m.label, kind: m.kind, avgKB: Math.round(r.avg), maxKB: r.max, spark: withSpark ? thin(sparkByKey.get(m.key) ?? []) : [] }] : [];
  };
  return { byAvg: byAvgRows.flatMap((r) => toConsumer(r, true)), byMax: byMaxRows.flatMap((r) => toConsumer(r, false)) };
}

/**
 * Sans groupKey : inchangé. Avec groupKey : pressure (système) ; leak du groupe ; app_kill et earlyoom_kill dont une cible
 * est un processus enregistré du groupe (procs.group_id) — ou dont group_id est le groupe. Cible : identité exacte
 * detail.targets [{pid, startTicks}] quand l'événement la porte ; sinon detail.pids / detail.pid d'un processus vivant au moment
 * du kill (échantillon dans les 2 min précédentes en détail, ou une ligne minute dans les 3 min précédentes) et, si
 * detail.name est donné (earlyoom), de même nom. Le groupe d'un processus est sa dernière classification (upsert du service).
 * Exclut gap et tmpfs.
 */
export function queryEvents(db: DatabaseSync, range: TimeRange, groupKey?: string): HistoryEvent[] {
  const base = `SELECT e.ts, e.type, g.key AS gk, g.label AS gl, e.detail FROM events e LEFT JOIN groups g ON g.id = e.group_id
       WHERE e.ts >= ? AND e.ts < ?`;
  // Un PID peut avoir été réutilisé : la cible n'appartient au groupe que si ce processus y vivait juste avant le kill.
  // `+p.group_id` écarte l'index procs_group : la recherche part des PID ciblés (index unique (pid, start_ticks)) au lieu
  // de parcourir les dizaines de milliers de processus d'un groupe à chaque kill (4,4 s → quelques ms sur 7 j).
  const rows = (
    groupKey === undefined
      ? db.prepare(`${base} ORDER BY e.ts`).all(range.from, range.to)
      : db
          .prepare(
            `WITH gs AS (SELECT id FROM groups WHERE key = ?)
             ${base}
             AND (e.type = 'pressure'
               OR (e.type = 'leak' AND e.group_id = (SELECT id FROM gs))
               OR (e.type IN ('app_kill', 'earlyoom_kill') AND (e.group_id = (SELECT id FROM gs)
                 -- identité exacte (pid + startTicks) quand l'événement la porte
                 OR EXISTS (
                   SELECT 1 FROM json_each(e.detail, '$.targets') t
                   JOIN procs p ON p.pid = json_extract(t.value, '$.pid') AND p.start_ticks = json_extract(t.value, '$.startTicks')
                   WHERE +p.group_id = (SELECT id FROM gs))
                 -- sinon pid vivant juste avant le kill, et même nom quand l'événement en donne un (earlyoom)
                 OR (json_type(e.detail, '$.targets') IS NULL AND EXISTS (
                   SELECT 1 FROM procs p
                   WHERE +p.group_id = (SELECT id FROM gs)
                     AND p.pid IN (SELECT CAST(value AS INTEGER) FROM json_each(e.detail, '$.pids') UNION ALL SELECT json_extract(e.detail, '$.pid'))
                     AND (json_extract(e.detail, '$.name') IS NULL OR p.name = json_extract(e.detail, '$.name'))
                     AND (EXISTS (SELECT 1 FROM proc_samples s WHERE s.proc_id = p.id AND s.ts BETWEEN e.ts - 120000 AND e.ts)
                          OR EXISTS (SELECT 1 FROM proc_minute m WHERE m.proc_id = p.id AND m.ts BETWEEN e.ts - 180000 AND e.ts)))))))
             ORDER BY e.ts`,
          )
          .all(groupKey, range.from, range.to)
  ) as { ts: number; type: string; gk: string | null; gl: string | null; detail: string }[];
  return rows.map((r) => ({ ts: r.ts, type: r.type, groupKey: r.gk, groupLabel: r.gl, detail: JSON.parse(r.detail) as Record<string, unknown> }));
}

export interface ProcAt {
  pid: number;
  startTicks: number;
  ppid: number | null;
  name: string;
  cmdline: string;
  rssKB: number;
  swapKB: number | null;
  cpu: number;
}

/**
 * État des processus enregistrés d'un groupe à l'instant ts : pour chacun, l'échantillon le plus récent dans
 * [ts - 2 x intervalle, ts] (détail), ou la ligne de la minute de ts (agrégats, rss = moyenne mémoire, swap inconnu).
 * Tolère une base v1 en lecture seule (ppid = NULL).
 */
export function queryProcsAt(db: DatabaseSync, groupKey: string, ts: number, o: QueryOpts): ProcAt[] {
  const ppid = hasColumn(db, 'procs', 'ppid') ? 'p.ppid' : 'NULL';
  const detail = ts >= o.now - o.detailHours * H;
  const rows = (
    detail
      ? db
          .prepare(
            `SELECT p.pid, p.start_ticks AS st, ${ppid} AS ppid, p.name, p.cmdline, s.rss_kb AS rss, s.swap_kb AS swap, s.cpu_percent AS cpu
             FROM procs p JOIN proc_samples s ON s.proc_id = p.id
              AND s.ts = (SELECT MAX(ts) FROM proc_samples WHERE proc_id = p.id AND ts >= ? AND ts <= ?)
             WHERE p.group_id = (SELECT id FROM groups WHERE key = ?)`,
          )
          .all(ts - 2 * o.intervalSec * 1000, ts, groupKey)
      : db
          .prepare(
            `SELECT p.pid, p.start_ticks AS st, ${ppid} AS ppid, p.name, p.cmdline, s.mem_kb_avg AS rss, NULL AS swap, s.cpu_avg AS cpu
             FROM procs p JOIN proc_minute s ON s.proc_id = p.id AND s.ts = ?
             WHERE p.group_id = (SELECT id FROM groups WHERE key = ?)`,
          )
          .all(Math.floor(ts / M) * M, groupKey)
  ) as { pid: number; st: number; ppid: number | null; name: string; cmdline: string; rss: number; swap: number | null; cpu: number }[];
  return rows
    .map((r) => ({ pid: r.pid, startTicks: r.st, ppid: r.ppid, name: r.name, cmdline: r.cmdline, rssKB: r.rss, swapKB: r.swap, cpu: r.cpu }))
    .sort((a, b) => b.rssKB + (b.swapKB ?? 0) - (a.rssKB + (a.swapKB ?? 0)));
}

/** Taille maximale de l'arbre rejoué : au-delà (fork bomb, make -j), seuls les plus gros processus sont renvoyés. */
export const PROC_TREE_MAX = 2000;

/**
 * Processus enregistrés du groupe à l'instant ts : par processus, l'échantillon le plus proche de ts dans [ts − intervalle, ts + intervalle]
 * (proc_samples si ts est dans la rétention détaillée), sinon la ligne de proc_minute la plus proche dans [minute(ts) − 1 min, minute(ts) + 1 min]
 * (swap inconnu). lastSeenTs = dernier échantillon connu du processus (MAX(ts) de proc_samples, sinon de proc_minute + 59 999).
 * Au plus PROC_TREE_MAX processus, les plus gros (rss + swap) ; `omitted` compte les autres. `recorded` : le service
 * échantillonnait autour de ts (system_samples à ± 2 intervalles, ou system_minute à ± 1 min).
 * Tolère une base v1 (ppid NULL). Aucun processus → procs: [].
 */
export function queryProcTree(db: DatabaseSync, groupKey: string, ts: number, o: QueryOpts): ProcTreeAt {
  const ppid = hasColumn(db, 'procs', 'ppid') ? 'p.ppid' : 'NULL';
  const source: ProcTreeAt['source'] = ts >= o.now - o.detailHours * H ? 'detail' : 'minute';
  const half = o.intervalSec * 1000;
  const minute = Math.floor(ts / M) * M;
  // Piloté par l'index sur ts (CROSS JOIN : proc_samples d'abord) : quelques centaines de lignes dans la fenêtre, quel que
  // soit le nombre de processus que le groupe a eus sur toute la rétention (176 000 pour 30 j de Claude : 0,6 ms au lieu de 30 à 90).
  // Une ligne par échantillon de la fenêtre, triées par processus puis distance à ts : la première de chaque id est retenue.
  const rows = (
    source === 'detail'
      ? db
          .prepare(
            `SELECT p.id, p.pid, p.start_ticks AS st, ${ppid} AS ppid, p.name, s.ts AS sts, s.rss_kb AS rss, s.swap_kb AS swap, s.cpu_percent AS cpu
             FROM proc_samples s CROSS JOIN procs p ON p.id = s.proc_id
             WHERE s.ts >= ? AND s.ts <= ? AND +p.group_id = (SELECT id FROM groups WHERE key = ?)
             ORDER BY p.id, ABS(s.ts - ?)`,
          )
          .all(ts - half, ts + half, groupKey, ts)
      : db
          .prepare(
            `SELECT p.id, p.pid, p.start_ticks AS st, ${ppid} AS ppid, p.name, s.ts AS sts, s.mem_kb_avg AS rss, NULL AS swap, s.cpu_avg AS cpu
             FROM proc_minute s CROSS JOIN procs p ON p.id = s.proc_id
             WHERE s.ts >= ? AND s.ts <= ? AND +p.group_id = (SELECT id FROM groups WHERE key = ?)
             ORDER BY p.id, ABS(s.ts - ?)`,
          )
          .all(minute - M, minute + M, groupKey, minute)
  ) as { id: number; pid: number; st: number; ppid: number | null; name: string; sts: number; rss: number; swap: number | null; cpu: number }[];
  const nearest: typeof rows = [];
  let prev = -1;
  for (const r of rows) {
    if (r.id === prev) continue;
    prev = r.id;
    nearest.push(r);
  }
  nearest.sort((a, b) => b.rss + (b.swap ?? 0) - (a.rss + (a.swap ?? 0)));
  const kept = nearest.slice(0, PROC_TREE_MAX);
  const lastDetail = db.prepare('SELECT MAX(ts) AS t FROM proc_samples WHERE proc_id = ?');
  const lastMinute = db.prepare('SELECT MAX(ts) AS t FROM proc_minute WHERE proc_id = ?');
  const lastSeen = (id: number, fallback: number): number => {
    const d = (lastDetail.get(id) as { t: number | null }).t;
    if (d !== null) return d;
    const m = (lastMinute.get(id) as { t: number | null }).t;
    return m !== null ? m + M - 1 : fallback;
  };
  const procs: ProcTreeRow[] = kept.map((r) => ({
    pid: r.pid, startTicks: r.st, ppid: r.ppid, name: r.name, rssKB: r.rss, swapKB: r.swap, cpu: r.cpu, sampleTs: r.sts, lastSeenTs: lastSeen(r.id, r.sts),
  }));
  const recorded =
    procs.length > 0 ||
    (source === 'detail'
      ? db.prepare('SELECT 1 FROM system_samples WHERE ts >= ? AND ts <= ? LIMIT 1').get(ts - 2 * half, ts + 2 * half)
      : db.prepare('SELECT 1 FROM system_minute WHERE ts >= ? AND ts <= ? LIMIT 1').get(minute - M, minute + M)) !== undefined;
  return { ts, source, procs, recorded, omitted: nearest.length - kept.length };
}

/** Seuil d'activité : un échantillon à ≥ 1 % de CPU suffit à rendre un processus actif. */
export const ACTIVE_CPU_PERCENT = 1;

/** Fenêtre lue dans la table détaillée par queryInactive (30 min) ; avant, les agrégats par minute (12 fois moins de lignes) : < 20 ms pour 200 processus inactifs sur 24 h. */
export const INACTIVE_DETAIL_MS = 30 * M;

/**
 * Pour « inactives depuis T » : renvoie les clés `${pid}:${startTicks}` des cibles **actives**, c'est-à-dire avec au moins
 * un échantillon CPU ≥ 1 % depuis `since`. Les 30 dernières minutes (au plus la rétention détaillée) sont lues dans
 * `proc_samples` ; la partie plus ancienne dans `proc_minute` (moyenne par minute ≥ 1 % : un pic plus court peut
 * échapper), depuis la minute entamée à `since`. Une cible jamais enregistrée (sous les seuils) n'est jamais active.
 * Par cible : clé unique (pid, start_ticks) puis parcours de la clé primaire (proc_id, ts) arrêté au premier échantillon actif.
 */
export function queryInactive(db: DatabaseSync, targets: { pid: number; startTicks: number }[], since: number, o: QueryOpts): Set<string> {
  const active = new Set<string>();
  if (targets.length === 0) return active;
  const split = o.now - Math.min(INACTIVE_DETAIL_MS, o.detailHours * H);
  const detailFrom = Math.max(since, split);
  const findProc = db.prepare('SELECT id FROM procs WHERE pid = ? AND start_ticks = ?');
  const detail = db.prepare('SELECT 1 FROM proc_samples WHERE proc_id = ? AND ts >= ? AND cpu_percent >= ? LIMIT 1');
  const minute = since < split ? db.prepare('SELECT 1 FROM proc_minute WHERE proc_id = ? AND ts >= ? AND ts < ? AND cpu_avg >= ? LIMIT 1') : null;
  // La ligne minute couvre [ts, ts + 1 min) : la minute entamée à `since` compte.
  const minuteFrom = Math.floor(since / M) * M;
  for (const t of targets) {
    const key = `${t.pid}:${t.startTicks}`;
    if (active.has(key)) continue;
    const row = findProc.get(t.pid, t.startTicks) as { id: number } | undefined;
    if (!row) continue;
    if (detail.get(row.id, detailFrom, ACTIVE_CPU_PERCENT) || minute?.get(row.id, minuteFrom, split, ACTIVE_CPU_PERCENT)) active.add(key);
  }
  return active;
}

/**
 * Cache de queryLastActive (par `pid:startTicks`) : résultat de la partie « minute » déjà lue, jusqu'à `upTo` (exclu). Les
 * minutes antérieures ne changent plus : un appel suivant ne lit que les minutes nouvelles (≈ 1 ms au lieu de ~200 ms pour
 * 100 processus endormis sur 30 jours). À vider quand la base change (recréée, vidée).
 */
export type LastActiveCache = Map<string, { upTo: number; ts: number | null }>;

/**
 * Vue swap : dernier échantillon CPU ≥ 1 % de chaque cible (`pid:startTicks`) dans les `lookbackMs`, null si aucun (ou cible
 * jamais enregistrée). Même découpage que queryInactive : les 30 dernières minutes dans `proc_samples` (instant exact), le
 * reste dans `proc_minute` (moyenne ≥ 1 %) ; la minute trouvée est précisée dans `proc_samples` tant que le détail existe
 * (sinon : début de la minute). Parcours de la clé primaire (proc_id, ts) du plus récent au plus ancien, arrêté au premier
 * échantillon actif.
 */
export function queryLastActive(
  db: DatabaseSync,
  targets: { pid: number; startTicks: number }[],
  lookbackMs: number,
  o: QueryOpts,
  cache?: LastActiveCache,
  activeCpu: number = ACTIVE_CPU_PERCENT,
): Map<string, number | null> {
  const out = new Map<string, number | null>();
  if (targets.length === 0) return out;
  const since = o.now - lookbackMs;
  const split = o.now - Math.min(INACTIVE_DETAIL_MS, o.detailHours * H);
  const findProc = db.prepare('SELECT id FROM procs WHERE pid = ? AND start_ticks = ?');
  const detail = db.prepare('SELECT ts FROM proc_samples WHERE proc_id = ? AND ts >= ? AND ts <= ? AND cpu_percent >= ? ORDER BY ts DESC LIMIT 1');
  const minute = db.prepare('SELECT ts FROM proc_minute WHERE proc_id = ? AND ts >= ? AND ts < ? AND cpu_avg >= ? ORDER BY ts DESC LIMIT 1');
  const minuteFrom = Math.floor(since / M) * M;
  /** Dernière minute active dans [from, split), précisée dans le détail s'il existe encore. */
  const lastMinute = (id: number, from: number): number | null => {
    if (from >= split) return null;
    const m = minute.get(id, from, split, activeCpu) as { ts: number } | undefined;
    if (!m) return null;
    const exact = detail.get(id, m.ts, m.ts + M - 1, activeCpu) as { ts: number } | undefined;
    return exact?.ts ?? m.ts;
  };
  for (const t of targets) {
    const key = `${t.pid}:${t.startTicks}`;
    if (out.has(key)) continue;
    const row = findProc.get(t.pid, t.startTicks) as { id: number } | undefined;
    if (!row) {
      out.set(key, null);
      continue;
    }
    const d = detail.get(row.id, Math.max(since, split), o.now, activeCpu) as { ts: number } | undefined;
    if (d) {
      out.set(key, d.ts);
      continue;
    }
    const c = cache?.get(key);
    const usable = c !== undefined && c.upTo <= split;
    const fresh = lastMinute(row.id, usable ? Math.max(minuteFrom, Math.floor(c.upTo / M) * M) : minuteFrom);
    const ts = fresh ?? (usable && c.ts !== null && c.ts >= since ? c.ts : null);
    cache?.set(key, { upTo: split, ts });
    out.set(key, ts);
  }
  return out;
}

/** Retire du cache les processus qui ne sont plus des cibles (l'appelant lit par tranches, puis élague une fois). */
export function pruneLastActiveCache(cache: LastActiveCache, keep: ReadonlySet<string>): void {
  for (const k of [...cache.keys()]) if (!keep.has(k)) cache.delete(k);
}

/** Trou toléré dans l'historique (redémarrage du service, mise en veille courte) avant de déclarer la couverture interrompue. */
export const COVERAGE_MAX_GAP_MS = 10 * M;

export interface HistoryCoverage {
  /** Dernier échantillon système enregistré (détail ; sans détail, fin de la dernière minute) ; null si la base est vide. */
  latestTs: number | null;
  /** Début de la couverture continue (aucun trou > 10 min) qui finit à `latestTs`, borné à `from` ; null si vide. */
  coveredFrom: number | null;
  /** La couverture s'arrête sur un trou (et non au début des données ou de la fenêtre). */
  gap: boolean;
}

/**
 * Couverture de l'historique sur [from, now] d'après la table système par minute (≤ 10 080 lignes pour 7 jours) : en
 * remontant depuis le dernier échantillon, premier trou de plus de 10 min entre deux minutes enregistrées.
 */
export function historyCoverage(db: DatabaseSync, from: number, now: number): HistoryCoverage {
  const detail = (db.prepare('SELECT MAX(ts) AS t FROM system_samples').get() as { t: number | null }).t;
  const lastMinute = (db.prepare('SELECT MAX(ts) AS t FROM system_minute').get() as { t: number | null }).t;
  // Le détail fait foi : la minute en cours peut déjà être agrégée (le service ré-agrège la minute entamée), sa fin serait dans le futur.
  const latestTs = detail ?? (lastMinute === null ? null : lastMinute + M);
  if (latestTs === null) return { latestTs: null, coveredFrom: null, gap: false };
  const rows = db.prepare('SELECT ts FROM system_minute WHERE ts >= ? AND ts <= ? ORDER BY ts DESC').all(Math.floor(from / M) * M - M, Math.min(now, latestTs)) as { ts: number }[];
  let cur = latestTs;
  let gap = false;
  for (const { ts } of rows) {
    if (cur - (ts + M) > COVERAGE_MAX_GAP_MS) {
      gap = true;
      break;
    }
    cur = Math.min(cur, ts);
  }
  // détail seul (minutes pas encore agrégées) : couvert depuis le plus ancien échantillon détaillé récent
  if (rows.length === 0 && detail !== null) {
    const first = (db.prepare('SELECT MIN(ts) AS t FROM system_samples WHERE ts >= ?').get(from) as { t: number | null }).t;
    if (first !== null) cur = first;
  }
  return { latestTs, coveredFrom: Math.max(cur, from), gap };
}

/** Premier instant couvert par l'historique : le plus ancien des tables système détaillée et par minute ; null si vide. */
export function historyFrom(db: DatabaseSync): number | null {
  const a = (db.prepare('SELECT MIN(ts) AS t FROM system_samples').get() as { t: number | null }).t;
  const b = (db.prepare('SELECT MIN(ts) AS t FROM system_minute').get() as { t: number | null }).t;
  if (a === null) return b;
  return b === null ? a : Math.min(a, b);
}
