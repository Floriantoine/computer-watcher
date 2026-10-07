// src/core/history/maintenance.ts
import type { DatabaseSync } from 'node:sqlite';
import { detectLeak } from './leak';

const M = 60_000;

export function aggregateMinute(db: DatabaseSync, minuteStart: number): void {
  const end = minuteStart + M;
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT OR REPLACE INTO system_minute
         (ts, mem_used_kb_avg, mem_used_kb_max, mem_total_kb, swap_used_kb_avg, swap_used_kb_max, swap_total_kb, psi_avg, psi_max, load1_avg, cpu_avg)
       SELECT ?, AVG(mem_used_kb), MAX(mem_used_kb), MAX(mem_total_kb), AVG(swap_used_kb), MAX(swap_used_kb), MAX(swap_total_kb),
              AVG(psi_some10), MAX(psi_some10), AVG(load1), AVG(cpu_percent)
       FROM system_samples WHERE ts >= ? AND ts < ? HAVING COUNT(*) > 0`,
    ).run(minuteStart, minuteStart, end);
    db.prepare(
      `INSERT OR REPLACE INTO group_minute
       (ts, group_id, rss_kb_avg, swap_kb_avg, mem_kb_max, cpu_avg)
       SELECT ?, group_id, AVG(rss_kb), AVG(swap_kb), MAX(rss_kb + swap_kb), AVG(cpu_percent)
       FROM group_samples WHERE ts >= ? AND ts < ? GROUP BY group_id`,
    ).run(minuteStart, minuteStart, end);
    db.prepare(
      `INSERT OR REPLACE INTO proc_minute
       (ts, proc_id, mem_kb_avg, mem_kb_max, cpu_avg)
       SELECT ?, proc_id, AVG(rss_kb + swap_kb), MAX(rss_kb + swap_kb), AVG(cpu_percent)
       FROM proc_samples WHERE ts >= ? AND ts < ? GROUP BY proc_id`,
    ).run(minuteStart, minuteStart, end);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function purge(db: DatabaseSync, now: number, detailHours: number, summaryDays: number): void {
  const detailCut = now - detailHours * 3600_000;
  const summaryCut = now - summaryDays * 86400_000;
  db.exec('BEGIN');
  try {
    for (const t of ['system_samples', 'group_samples', 'proc_samples']) db.prepare(`DELETE FROM ${t} WHERE ts < ?`).run(detailCut);
    for (const t of ['system_minute', 'group_minute', 'proc_minute', 'events']) db.prepare(`DELETE FROM ${t} WHERE ts < ?`).run(summaryCut);
    db.exec(`DELETE FROM procs WHERE NOT EXISTS (SELECT 1 FROM proc_samples s WHERE s.proc_id = procs.id)
             AND NOT EXISTS (SELECT 1 FROM proc_minute m WHERE m.proc_id = procs.id)`);
    db.exec(`DELETE FROM groups WHERE NOT EXISTS (SELECT 1 FROM group_samples s WHERE s.group_id = groups.id)
             AND NOT EXISTS (SELECT 1 FROM group_minute m WHERE m.group_id = groups.id)
             AND NOT EXISTS (SELECT 1 FROM events e WHERE e.group_id = groups.id)
             AND NOT EXISTS (SELECT 1 FROM procs p WHERE p.group_id = groups.id)`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  db.exec('PRAGMA incremental_vacuum(2000);');
}

export function clearAll(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    for (const t of ['system_samples', 'group_samples', 'proc_samples', 'system_minute', 'group_minute', 'proc_minute', 'events', 'procs', 'groups']) {
      db.exec(`DELETE FROM ${t}`);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  db.exec('PRAGMA incremental_vacuum;');
}

export function leakCandidates(
  db: DatabaseSync,
  now: number,
  minMinutes: number,
  minGrowthMB: number,
): { groupId: number; key: string; label: string; growthKB: number }[] {
  const end = Math.floor(now / M) * M;
  const from = end - (minMinutes + 1) * M;
  const rows = db
    .prepare(
      `SELECT gm.group_id AS gid, g.key AS key, g.label AS label, gm.rss_kb_avg + gm.swap_kb_avg AS mem
       FROM group_minute gm JOIN groups g ON g.id = gm.group_id
       WHERE gm.ts >= ? AND gm.ts < ? ORDER BY gm.group_id, gm.ts`,
    )
    .all(from, end) as { gid: number; key: string; label: string; mem: number }[];
  const recent = new Set(
    (db.prepare(`SELECT group_id FROM events WHERE type = 'leak' AND ts >= ?`).all(end - 3600_000) as { group_id: number }[]).map((r) => r.group_id),
  );
  const byGroup = new Map<number, { key: string; label: string; series: number[] }>();
  for (const r of rows) {
    const e = byGroup.get(r.gid) ?? { key: r.key, label: r.label, series: [] };
    e.series.push(r.mem);
    byGroup.set(r.gid, e);
  }
  const out: { groupId: number; key: string; label: string; growthKB: number }[] = [];
  for (const [gid, e] of byGroup) {
    if (recent.has(gid)) continue;
    const r = detectLeak(e.series, minMinutes, minGrowthMB * 1024);
    if (r.leak) out.push({ groupId: gid, key: e.key, label: e.label, growthKB: r.growthKB });
  }
  return out;
}
