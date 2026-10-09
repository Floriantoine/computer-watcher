// src/core/history/queries.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createV3Db, openTestDb } from './testDb';
import { aggregateMinute } from './maintenance';
import { bucketMs, historyCovers, queryRuleStats, pickSource, queryInactive, queryCulprits, queryEvents, queryGroup, queryGroups, PROC_TREE_MAX, queryProcs, queryProcsAt, queryProcTree, querySystem, queryTop, rangeFromPreset, historyCoverage, historyFrom, pruneLastActiveCache, queryLastActive } from './queries';

const H = 3600_000;
const M = 60_000;
const opts = (now: number) => ({ now, detailHours: 24, intervalSec: 5 });

function seeded() {
  const path = join(mkdtempSync(join(tmpdir(), 'pw-q-')), 'm.db');
  const { db } = openTestDb(path);
  db.exec(`INSERT INTO groups(id,key,label,kind) VALUES (1,'app:chrome','Chrome','app'), (2,'project:/a','a','project');
           INSERT INTO procs_in(id,pid,start_ticks,name,cmdline,group_id) VALUES (1,10,100,'chrome','chrome',1);`);
  // 10 minutes, un tick toutes les 5 s ; Chrome monte de 1 Mo par tick, a reste à 500 Mo
  for (let ts = 0; ts < 10 * M; ts += 5000) {
    const chrome = 1000 * 1024 + (ts / 5000) * 1024;
    db.prepare('INSERT INTO system_samples(ts, mem_used_kb, mem_total_kb, swap_used_kb, swap_total_kb, psi_some10, load1, cpu_percent) VALUES (?,?,?,?,?,?,?,?)').run(ts, chrome + 500 * 1024, 32_000_000, 100, 20_000_000, 2, 1, 10);
    db.prepare('INSERT INTO group_samples VALUES (?,?,?,?,?,?)').run(ts, 1, chrome, 0, 5, 3);
    db.prepare('INSERT INTO group_samples VALUES (?,?,?,?,?,?)').run(ts, 2, 500 * 1024, 0, 1, 1);
    db.prepare('INSERT INTO proc_samples VALUES (?,?,?,?,?)').run(ts, 1, chrome, 0, 5);
  }
  for (let m = 0; m < 10; m++) aggregateMinute(db, m * M);
  db.exec(`INSERT INTO events(ts,type,group_id,detail) VALUES (${5 * M},'pressure',NULL,'{"psi":30}'), (${6 * M},'leak',1,'{"growthKB":1}')`);
  return { db, path };
}

test('rangeFromPreset / pickSource / bucketMs', () => {
  expect(rangeFromPreset('6h', 10 * H)).toEqual({ from: 4 * H, to: 10 * H });
  expect(pickSource({ from: 9 * H, to: 10 * H }, 10 * H, 24)).toBe('detail');
  expect(pickSource({ from: 0, to: 48 * H }, 48 * H, 24)).toBe('minute');
  expect(pickSource({ from: 0, to: 1 * H }, 48 * H, 24)).toBe('minute'); // plus vieux que la rétention détaillée
  expect(pickSource({ from: 24 * H, to: 48 * H }, 48 * H, 48)).toBe('minute'); // bucket détaillé 90 s >= 1 min
  expect(pickSource({ from: 42 * H, to: 48 * H }, 48 * H, 24)).toBe('minute'); // 6 h : bucket détaillé 25 s >= 15 s (était 'detail' avant le seuil de 15 s)
  expect(pickSource({ from: 46 * H, to: 48 * H }, 48 * H, 24)).toBe('detail'); // 2 h : bucket 10 s
  expect(pickSource({ from: 0, to: 48 * H }, 100 * H, 24)).toBe('minute'); // 48 h tout juste : encore les minutes
  expect(pickSource({ from: 0, to: 49 * H }, 100 * H, 24)).toBe('hour'); // > 48 h : tables horaires
  expect(pickSource(rangeFromPreset('7d', 1000 * H), 1000 * H, 24)).toBe('hour');
  expect(pickSource(rangeFromPreset('30d', 1000 * H), 1000 * H, 24)).toBe('hour');
  expect(pickSource(rangeFromPreset('24h', 1000 * H), 1000 * H, 24)).toBe('minute');
  expect(bucketMs(rangeFromPreset('30d', 1000 * H), 'hour', 5)).toBe(H);
  expect(bucketMs({ from: 0, to: H }, 'detail', 5)).toBe(5000);
  expect(bucketMs({ from: 0, to: 24 * H }, 'detail', 5)).toBe(90_000);
  expect(bucketMs({ from: 0, to: 30 * 24 * H }, 'minute', 5)).toBe(44 * M);
});

test('querySystem : ≤ 1000 points, valeurs au max du bucket', () => {
  const { db } = seeded();
  const s = querySystem(db, { from: 0, to: 10 * M }, opts(10 * M));
  expect(s.ts.length).toBe(120);
  expect(s.memTotalKB).toBe(32_000_000);
  expect(s.memUsedKB[0]).toBe(1500 * 1024);
  expect(s.psi.every((v) => v === 2)).toBe(true);
});

test('queryGroups : aligné, filtrable par clés', () => {
  const { db } = seeded();
  const all = queryGroups(db, { from: 0, to: 10 * M }, opts(10 * M));
  expect(all.series.map((s) => s.key).sort()).toEqual(['app:chrome', 'project:/a']);
  expect(all.series.every((s) => s.memKB.length === all.ts.length)).toBe(true);
  const one = queryGroups(db, { from: 0, to: 10 * M }, opts(10 * M), ['project:/a']);
  expect(one.series).toEqual([{ key: 'project:/a', label: 'a', kind: 'project', memKB: Array(one.ts.length).fill(500 * 1024) }]);
});

test('queryGroups sur une plage ancienne : lit les minutes', () => {
  const { db } = seeded();
  const r = queryGroups(db, { from: 0, to: 10 * M }, opts(48 * H));
  expect(r.ts).toEqual(Array.from({ length: 10 }, (_, i) => i * M));
});

test('queryGroup et queryProcs', () => {
  const { db } = seeded();
  const g = queryGroup(db, 'app:chrome', { from: 0, to: 10 * M }, opts(10 * M));
  expect(g.ts.length).toBe(120);
  expect(g.cpu[0]).toBe(5);
  expect(g.procCount?.[0]).toBe(3); // détail : nombre de processus de l'échantillon (tuile « Processus » au survol)
  // par minute : non enregistré
  expect(queryGroup(db, 'app:chrome', { from: 0, to: 10 * M }, opts(48 * H)).procCount).toBeUndefined();
  const p = queryProcs(db, 'app:chrome', { from: 0, to: 10 * M }, opts(10 * M));
  expect(p.series).toHaveLength(1);
  expect(p.series[0]).toMatchObject({ pid: 10, startTicks: 100 });
});

test('queryCulprits : hausse sur les 5 min avant ts, triée', () => {
  const { db } = seeded();
  const c = queryCulprits(db, 9 * M, opts(10 * M));
  expect(c[0]).toMatchObject({ key: 'app:chrome', deltaKB: 60 * 1024 });
  expect(c[1]).toMatchObject({ key: 'project:/a', deltaKB: 0 });
});

function culpritDb(table: 'group_samples' | 'group_minute', rows: [number, number, number][]) {
  const path = join(mkdtempSync(join(tmpdir(), 'pw-c-')), 'm.db');
  const { db } = openTestDb(path);
  db.exec(`INSERT INTO groups(id,key,label,kind) VALUES (1,'app:flat','Flat','app'), (2,'app:new','New','app')`);
  for (const [ts, gid, mem] of rows) {
    if (table === 'group_samples') db.prepare('INSERT INTO group_samples VALUES (?,?,?,?,?,?)').run(ts, gid, mem, 0, 5, 3);
    else db.prepare('INSERT INTO group_minute(ts,group_id,rss_kb_avg,swap_kb_avg,cpu_avg,mem_kb_max) VALUES (?,?,?,?,?,?)').run(ts, gid, mem, 0, 3, mem);
  }
  return db;
}

test('queryCulprits : groupe apparu au dernier tick (5 Mo -> 10 Go, replié avant) : delta = mémoire finale', () => {
  const now = 10 * M;
  const rows: [number, number, number][] = [];
  for (let ts = 5 * M; ts <= now; ts += 5000) rows.push([ts, 1, 500 * 1024]);
  rows.push([now, 2, 10 * 1024 * 1024]);
  const c = queryCulprits(culpritDb('group_samples', rows), now, opts(now));
  expect(c[0]).toMatchObject({ key: 'app:new', deltaKB: 10 * 1024 * 1024, memKB: 10 * 1024 * 1024 });
  expect(c[1]).toMatchObject({ key: 'app:flat', deltaKB: 0 });
});

test('queryCulprits : groupe présent toute la fenêtre, delta inchangé (dernier - premier)', () => {
  const now = 10 * M;
  const rows: [number, number, number][] = [];
  for (let ts = 5 * M; ts <= now; ts += 5000) rows.push([ts, 2, 1000 + (ts - 5 * M) / 5000]);
  const c = queryCulprits(culpritDb('group_samples', rows), now, opts(now));
  expect(c[0]).toMatchObject({ key: 'app:new', deltaKB: 60, memKB: 1060 });
});

test('queryCulprits : même règle sur la source minute', () => {
  const now = 100 * H;
  const at = 50 * H; // fenêtre plus vieille que la rétention détaillée : agrégats par minute
  const rows: [number, number, number][] = [];
  for (let m = 5; m >= 0; m--) rows.push([at - m * M, 1, 500 * 1024]);
  rows.push([at, 2, 10 * 1024 * 1024]); // apparu à la dernière minute
  const db = culpritDb('group_minute', rows);
  for (let m = 5; m >= 0; m--) db.prepare('INSERT INTO system_minute(ts, mem_used_kb_avg, mem_used_kb_max, mem_total_kb, swap_used_kb_avg, swap_used_kb_max, swap_total_kb, psi_avg, psi_max, load1_avg, cpu_avg) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(at - m * M, 1, 1, 100, 0, 0, 100, 0, 0, 1, 1);
  const c = queryCulprits(db, at, opts(now));
  expect(c[0]).toMatchObject({ key: 'app:new', deltaKB: 10 * 1024 * 1024 });
  expect(c[1]).toMatchObject({ key: 'app:flat', deltaKB: 0 });
});

test('queryCulprits : trou du recorder au début de la fenêtre, groupe stable : pas de faux « apparu » (détaillé)', () => {
  const now = 10 * M;
  const rows: [number, number, number][] = [];
  for (let ts = 5 * M + 3 * M; ts <= now; ts += 5000) rows.push([ts, 2, 2 * 1024 * 1024 + (ts - 8 * M) / 5000]);
  const c = queryCulprits(culpritDb('group_samples', rows), now, opts(now));
  expect(c[0]).toMatchObject({ key: 'app:new', deltaKB: 24 });
});

test('queryCulprits : trou du recorder au début de la fenêtre (minute)', () => {
  const now = 100 * H;
  const at = 50 * H;
  const rows: [number, number, number][] = [];
  for (let m = 2; m >= 0; m--) rows.push([at - m * M, 2, 2 * 1024 * 1024]);
  const db = culpritDb('group_minute', rows);
  for (let m = 2; m >= 0; m--) db.prepare('INSERT INTO system_minute(ts, mem_used_kb_avg, mem_used_kb_max, mem_total_kb, swap_used_kb_avg, swap_used_kb_max, swap_total_kb, psi_avg, psi_max, load1_avg, cpu_avg) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(at - m * M, 1, 1, 100, 0, 0, 100, 0, 0, 1, 1);
  expect(queryCulprits(db, at, opts(now))[0]).toMatchObject({ key: 'app:new', deltaKB: 0 });
});

test('queryTop et queryEvents', () => {
  const { db } = seeded();
  const top = queryTop(db, { from: 0, to: 10 * M }, opts(10 * M)).byAvg;
  expect(top[0].key).toBe('app:chrome');
  expect(top[0].spark.length).toBeLessThanOrEqual(60);
  expect(queryEvents(db, { from: 0, to: 10 * M })).toEqual([
    { ts: 5 * M, type: 'pressure', groupKey: null, groupLabel: null, detail: { psi: 30 } },
    { ts: 6 * M, type: 'leak', groupKey: 'app:chrome', groupLabel: 'Chrome', detail: { growthKB: 1 } },
  ]);
});

test('queryTop by max : un pic court et une moyenne basse remontent par le max, pas par la moyenne', () => {
  const { db } = seeded();
  // Groupe 3 : 100 Mo, sauf un pic de 2 Go pendant 30 s (6 ticks) : moyenne ≈ 197 Mo, sous les 500 Mo de « a ».
  db.exec(`INSERT INTO groups(id,key,label,kind) VALUES (3,'command:vitest','vitest','command')`);
  for (let ts = 0; ts < 10 * M; ts += 5000) {
    const v = ts >= 4 * M && ts < 4 * M + 30_000 ? 2 * 1024 * 1024 : 100 * 1024;
    db.prepare('INSERT INTO group_samples VALUES (?,?,?,?,?,?)').run(ts, 3, v, 0, 1, 1);
  }
  for (let m = 0; m < 10; m++) {
    db.exec(`DELETE FROM group_minute WHERE ts = ${m * M}`);
    aggregateMinute(db, m * M);
  }
  const r = { from: 0, to: 10 * M };
  const { byAvg, byMax } = queryTop(db, r, opts(10 * M), { limit: 2, peakLimit: 2 });
  expect(byAvg.map((t) => t.key)).toEqual(['app:chrome', 'project:/a']);
  expect(byMax.map((t) => t.key)).toEqual(['command:vitest', 'app:chrome']);
  expect(byMax[0].maxKB).toBe(2 * 1024 * 1024);
  // Sur une plage ancienne (agrégats minute), le pic survit grâce à mem_kb_max.
  const old = queryTop(db, r, opts(48 * H), { limit: 1, peakLimit: 1 }).byMax;
  expect(old.map((t) => [t.key, t.maxKB])).toEqual([['command:vitest', 2 * 1024 * 1024]]);
});

test('lecture seule pendant qu\'un écrivain tient une transaction : pas d\'erreur', () => {
  const { db, path } = seeded();
  const reader = openTestDb(path, { readOnly: true }).db;
  db.exec('BEGIN');
  db.prepare('INSERT INTO system_samples(ts, mem_used_kb, mem_total_kb, swap_used_kb, swap_total_kb, psi_some10, load1, cpu_percent) VALUES (?,?,?,?,?,?,?,?)').run(10 * M, 1, 1, 1, 1, null, 0, 0);
  expect(() => querySystem(reader, { from: 0, to: 11 * M }, opts(11 * M))).not.toThrow();
  db.exec('COMMIT');
  reader.close();
});

test('au plus 1000 points même quand from n\'est pas aligné sur le bucket', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pw-q-')), 'm.db');
  const { db } = openTestDb(path);
  db.exec('BEGIN');
  const ins = db.prepare('INSERT INTO system_samples(ts, mem_used_kb, mem_total_kb, swap_used_kb, swap_total_kb, psi_some10, load1, cpu_percent) VALUES (?,?,?,?,?,?,?,?)');
  for (let ts = 0; ts <= 5_010_000; ts += 1000) ins.run(ts, 1, 1, 1, 1, null, 0, 0);
  db.exec('COMMIT');
  const to = 5_004_000;
  const s = querySystem(db, { from: 4000, to }, { now: to, detailHours: 24, intervalSec: 5 });
  expect(s.ts.length).toBe(1000);
  expect(s.ts[0]).toBe(4000);
});

test('queryProcs : une série par processus du groupe (pas de collision avec groups.key)', () => {
  const { db } = seeded();
  db.exec(`INSERT INTO procs_in(id,pid,start_ticks,name,cmdline,group_id) VALUES (2,11,200,'chrome','chrome --type=renderer',1);`);
  for (let ts = 0; ts < 10 * M; ts += 5000) db.prepare('INSERT INTO proc_samples VALUES (?,?,?,?,?)').run(ts, 2, 300 * 1024, 0, 1);
  for (let m = 0; m < 10; m++) aggregateMinute(db, m * M);
  for (const range of [{ from: 0, to: 10 * M }, { from: 0, to: 30 * H }]) {
    const p = queryProcs(db, 'app:chrome', range, opts(10 * M));
    expect(p.series.map((s) => `${s.pid}:${s.startTicks}`).sort()).toEqual(['10:100', '11:200']);
    expect(p.series.find((s) => s.pid === 11)!.memKB.every((v) => v === 300 * 1024)).toBe(true);
  }
});

test('queryProcsAt : état à l\'instant demandé, mort/naissance, tri, repli minute', () => {
  const { db } = openTestDb(join(mkdtempSync(join(tmpdir(), 'pw-at-')), 'm.db'));
  db.exec(`INSERT INTO groups(id,key,label,kind) VALUES (1,'g','g','app');
           INSERT INTO procs_in(id,pid,start_ticks,name,cmdline,group_id,ppid) VALUES
             (1,10,1,'root','root',1,1), (2,11,1,'dead','dead',1,10), (3,12,1,'late','late',1,10);`);
  const ins = db.prepare('INSERT INTO proc_samples VALUES (?,?,?,?,?)');
  for (let ts = 0; ts <= 100_000; ts += 5000) {
    ins.run(ts, 1, 1000, 0, 1);
    if (ts <= 40_000) ins.run(ts, 2, 5000, 100, 2); // meurt après 40 s
    if (ts >= 70_000) ins.run(ts, 3, 300, 0, 0); // naît à 70 s
  }
  const o = { now: 101_000, detailHours: 24, intervalSec: 5 };
  const at = (ts: number) => queryProcsAt(db, 'g', ts, o);
  expect(at(30_000).map((p) => p.pid)).toEqual([11, 10]); // trié par rss+swap décroissant
  expect(at(30_000)[0]).toEqual({ pid: 11, startTicks: 1, ppid: 10, name: 'dead', cmdline: 'dead', rssKB: 5000, swapKB: 100, cpu: 2 });
  expect(at(48_000).map((p) => p.pid)).toEqual([11, 10]); // mort depuis < 2 x 5 s : encore là
  expect(at(60_000).map((p) => p.pid)).toEqual([10]); // mort depuis > 2 x 5 s
  expect(at(60_000).map((p) => p.pid)).not.toContain(12); // pas encore né
  expect(at(100_000).map((p) => p.pid)).toEqual([10, 12]);
  expect(queryProcsAt(db, 'absent', 30_000, o)).toEqual([]);
  // hors rétention détaillée : proc_minute
  aggregateMinute(db, 0);
  const old = { now: 100 * H, detailHours: 24, intervalSec: 5 };
  const m = queryProcsAt(db, 'g', 30_000, old);
  expect(m.map((p) => [p.pid, p.ppid, p.swapKB])).toEqual([[11, 10, null], [10, 1, null]]);
});

test('queryProcsAt sur une base v1 avec lignes, ouverte en lecture seule : ppid null', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'pw-v1-')), 'm.db');
  const w = createV3Db(p); // schéma figé, ramené en v1
  w.exec(`INSERT INTO groups(id,key,label,kind) VALUES (1,'g','g','app');
          ALTER TABLE procs DROP COLUMN ppid;
          INSERT INTO procs(id,pid,start_ticks,name,cmdline,group_id) VALUES (1,10,1,'a','a',1);
          INSERT INTO proc_samples VALUES (1000,1,500,5,2);
          INSERT INTO proc_minute VALUES (0,1,505,600,2);
          PRAGMA user_version = 1;`);
  w.close();
  const { db } = openTestDb(p, { readOnly: true });
  const want = { pid: 10, startTicks: 1, ppid: null, name: 'a', cmdline: 'a' };
  expect(queryProcsAt(db, 'g', 1000, { now: 2000, detailHours: 24, intervalSec: 5 })).toEqual([{ ...want, rssKB: 500, swapKB: 5, cpu: 2 }]);
  expect(queryProcsAt(db, 'g', 1000, { now: 100 * H, detailHours: 24, intervalSec: 5 })).toEqual([{ ...want, rssKB: 505, swapKB: null, cpu: 2 }]);
  db.close();
});

test('queryTop : moyenne et pic en un seul parcours GROUP BY', () => {
  const { db } = seeded();
  const sqls: string[] = [];
  const spy = new Proxy(db, {
    get(t, k) {
      if (k === 'prepare') return (sql: string) => (sqls.push(sql), t.prepare(sql));
      const v = Reflect.get(t, k);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  const r = queryTop(spy, { from: 0, to: 10 * M }, opts(10 * M), { limit: 1, peakLimit: 2 });
  expect(r.byAvg.map((t) => t.key)).toEqual(['app:chrome']);
  expect(r.byMax.map((t) => t.key)).toEqual(['app:chrome', 'project:/a']);
  expect(sqls.filter((q) => /GROUP BY group_id\b/.test(q))).toHaveLength(1);
});

function hourSeeded() {
  const { db } = openTestDb(join(mkdtempSync(join(tmpdir(), 'pw-q-')), 'm.db'));
  db.exec(`INSERT INTO groups(id,key,label,kind) VALUES (1,'app:a','A','app'), (2,'others:small','Petits groupes','others');
           INSERT INTO procs_in(id,pid,start_ticks,name,cmdline,group_id) VALUES (1,10,100,'a','a',1);`);
  // 10 jours : seules les tables horaires (et proc_minute) sont remplies, pour vérifier la source choisie
  for (let h = 0; h < 240; h++) {
    db.prepare('INSERT INTO group_hour VALUES (?,?,?,?,?,?)').run(h * H, 1, 1000 + h, 0, 2000 + h, 5);
    db.prepare('INSERT INTO group_hour VALUES (?,?,?,?,?,?)').run(h * H, 2, 300, 0, 300, 1);
    db.prepare('INSERT INTO system_hour(ts, mem_used_kb_avg, mem_used_kb_max, mem_total_kb, swap_used_kb_avg, swap_used_kb_max, swap_total_kb, psi_avg, psi_max, load1_avg, cpu_avg) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(h * H, 5000, 6000 + h, 8000, 0, 0, 100, 1, 2, 0.5, 10);
    db.prepare('INSERT INTO proc_minute VALUES (?,?,?,?,?)').run(h * H, 1, 900, 950 + h, 5);
  }
  return db;
}

test('plages > 48 h : système, groupes, groupe, top et processus lus dans les tables horaires', () => {
  const db = hourSeeded();
  const now = 240 * H;
  const o = opts(now);
  const r = rangeFromPreset('7d', now);
  const sys = querySystem(db, r, o);
  expect(sys.ts).toHaveLength(168);
  expect(sys.memUsedKB.at(-1)).toBe(6000 + 239);
  const g = queryGroups(db, r, o, ['app:a']);
  expect(g.series[0].memKB.at(-1)).toBe(2000 + 239);
  expect(queryGroup(db, 'app:a', r, o).rssKB.at(-1)).toBe(1000 + 239);
  const top = queryTop(db, r, o);
  expect(top.byAvg.map((t) => t.key)).toEqual(['app:a', 'others:small']);
  expect(top.byMax[0]).toMatchObject({ key: 'app:a', maxKB: 2000 + 239 });
  expect(queryProcs(db, 'app:a', r, o).series[0].memKB.at(-1)).toBe(950 + 239);
});

test('base v2 (sans tables horaires, lecture seule) : les plages > 48 h retombent sur les minutes', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pw-q-')), 'm.db');
  const { db: w } = openTestDb(path);
  w.exec(`DROP TABLE group_hour; DROP TABLE system_hour; PRAGMA user_version = 2;
          INSERT INTO groups(id,key,label,kind) VALUES (1,'app:a','A','app');`);
  for (let m = 0; m < 3; m++) {
    w.prepare('INSERT INTO group_minute VALUES (?,?,?,?,?,?)').run(100 * H + m * M, 1, 10, 0, 10, 0);
    w.prepare('INSERT INTO system_minute(ts, mem_used_kb_avg, mem_used_kb_max, mem_total_kb, swap_used_kb_avg, swap_used_kb_max, swap_total_kb, psi_avg, psi_max, load1_avg, cpu_avg) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(100 * H + m * M, 1, 1, 8, 0, 0, 1, null, null, 0, 0);
  }
  w.close();
  const { db } = openTestDb(path, { readOnly: true });
  const r = rangeFromPreset('7d', 101 * H);
  expect(querySystem(db, r, opts(101 * H)).ts.length).toBeGreaterThan(0);
  expect(queryTop(db, r, opts(101 * H)).byAvg.map((t) => t.key)).toEqual(['app:a']);
});

describe('queryInactive (« inactives depuis »)', () => {
  /** p 20 : CPU 5 % il y a 10 min, 0 % sinon ; p 21 : CPU 0,5 % ; p 22 : jamais enregistré. now = 2 h. */
  function inactiveDb() {
    const path = join(mkdtempSync(join(tmpdir(), 'pw-q-')), 'm.db');
    const { db } = openTestDb(path);
    db.exec(`INSERT INTO groups(id,key,label,kind) VALUES (1,'project:/a','a','project');
             INSERT INTO procs_in(id,pid,start_ticks,name,cmdline,group_id) VALUES (1,20,200,'vite','vite',1), (2,21,210,'node','node',1);`);
    const now = 2 * H;
    for (let ts = now - 60 * M; ts < now; ts += 5000) {
      db.prepare('INSERT INTO proc_samples VALUES (?,?,?,?,?)').run(ts, 1, 1000, 0, ts === now - 10 * M ? 5 : 0);
      db.prepare('INSERT INTO proc_samples VALUES (?,?,?,?,?)').run(ts, 2, 1000, 0, 0.5);
    }
    return { db, now };
  }
  const targets = [{ pid: 20, startTicks: 200 }, { pid: 21, startTicks: 210 }, { pid: 22, startTicks: 220 }];

  test('CPU 5 % il y a 10 min : actif depuis 1 h, inactif depuis 5 min ; sous 1 % ou jamais enregistré : inactif', () => {
    const { db, now } = inactiveDb();
    expect(queryInactive(db, targets, now - H, opts(now))).toEqual(new Set(['20:200']));
    expect(queryInactive(db, targets, now - 5 * M, opts(now))).toEqual(new Set());
    expect(queryInactive(db, [], now - H, opts(now))).toEqual(new Set());
  });

  test('au-delà des 30 dernières minutes : agrégats par minute (moyenne ≥ 1 %)', () => {
    const { db, now } = inactiveDb();
    db.prepare('UPDATE proc_samples SET cpu_percent = 0 WHERE proc_id = 1').run();
    db.prepare('UPDATE proc_samples SET cpu_percent = 30 WHERE proc_id = 1 AND ts = ?').run(now - 45 * M);
    // pas encore agrégé : la partie ancienne de la fenêtre ne lit pas le détail
    expect(queryInactive(db, targets, now - H, opts(now))).toEqual(new Set());
    for (let m = now - 60 * M; m < now; m += M) aggregateMinute(db, m);
    // 30 % sur 1 échantillon de 12 → moyenne 2,5 % sur la minute : actif
    expect(queryInactive(db, targets, now - H, opts(now))).toEqual(new Set(['20:200']));
    expect(queryInactive(db, targets, now - 40 * M, opts(now))).toEqual(new Set());
  });

  test('au-delà de la rétention détaillée : lit aussi les minutes', () => {
    const { db } = inactiveDb();
    // seulement des agrégats minute (détail purgé) : p 20 à 3 % de moyenne il y a 30 h
    const now = 40 * H;
    db.exec('DELETE FROM proc_samples');
    db.prepare('INSERT INTO proc_minute VALUES (?,?,?,?,?)').run(10 * H, 1, 1000, 1000, 3);
    db.prepare('INSERT INTO proc_minute VALUES (?,?,?,?,?)').run(10 * H, 2, 1000, 1000, 0.2);
    expect(queryInactive(db, targets, now - 31 * H, opts(now))).toEqual(new Set(['20:200']));
    expect(queryInactive(db, targets, now - 29 * H, opts(now))).toEqual(new Set());
    // échantillon détaillé récent aussi pris en compte quand la période dépasse la rétention
    db.prepare('INSERT INTO proc_samples VALUES (?,?,?,?,?)').run(now - M, 2, 1000, 0, 2);
    expect(queryInactive(db, targets, now - 31 * H, opts(now))).toEqual(new Set(['20:200', '21:210']));
  });
});

describe('queryProcTree (rejeu de l\'arbre)', () => {
  const now = 10 * H;
  const ts = 9 * H;
  const o = opts(now);
  /** A (10) → D (11) ; C (12, enfant de A) mort à ts − 30 s ; B (13) né à ts + 60 s ; h (groupe voisin) : E (20). */
  function treeDb() {
    const { db } = openTestDb(join(mkdtempSync(join(tmpdir(), 'pw-tree-')), 'm.db'));
    db.exec(`INSERT INTO groups(id,key,label,kind) VALUES (1,'g','g','app'), (2,'h','h','app');
             INSERT INTO procs_in(id,pid,start_ticks,name,cmdline,group_id,ppid) VALUES
               (1,10,1,'A','a',1,1), (2,11,1,'D','d',1,10), (3,12,1,'C','c',1,10), (4,13,1,'B','b',1,10), (5,20,1,'E','e',2,1);`);
    const ins = db.prepare('INSERT INTO proc_samples VALUES (?,?,?,?,?)');
    ins.run(ts - 3000, 1, 1000, 10, 1);
    ins.run(ts + 2000, 1, 1200, 20, 3);
    ins.run(ts, 2, 500, 0, 0);
    ins.run(ts, 5, 9000, 0, 0);
    for (let t = ts - 120_000; t <= ts - 30_000; t += 5000) ins.run(t, 3, 700, 0, 1);
    for (let t = ts + 60_000; t <= ts + 120_000; t += 5000) ins.run(t, 4, 300, 0, 1);
    return db;
  }

  test('détail : échantillon le plus proche à ± 1 intervalle, nés après et morts avant absents', () => {
    const db = treeDb();
    const r = queryProcTree(db, 'g', ts, o);
    expect(r.ts).toBe(ts);
    expect(r.source).toBe('detail');
    expect(r.procs.map((p) => p.pid).sort()).toEqual([10, 11]);
    const a = r.procs.find((p) => p.pid === 10)!;
    expect(a).toEqual({ pid: 10, startTicks: 1, ppid: 1, name: 'A', rssKB: 1200, swapKB: 20, cpu: 3, sampleTs: ts + 2000, lastSeenTs: ts + 2000 });
    expect(r.procs.find((p) => p.pid === 11)!.ppid).toBe(10);
  });

  test('détail : lastSeenTs = dernier échantillon connu (processus mort depuis)', () => {
    const r = queryProcTree(treeDb(), 'g', ts - 40_000, o);
    expect(r.procs.map((p) => [p.pid, p.sampleTs, p.lastSeenTs])).toEqual([[12, ts - 40_000, ts - 30_000]]);
  });

  test('instant dans un trou (aucun échantillon à ± 5 s) ou groupe inconnu : procs vide', () => {
    const db = treeDb();
    expect(queryProcTree(db, 'g', ts - 30 * M, o)).toEqual({ ts: ts - 30 * M, source: 'detail', procs: [], recorded: false, omitted: 0 });
    expect(queryProcTree(db, 'absent', ts, o).procs).toEqual([]);
  });

  test('trou d\'enregistrement ou processus sous les seuils : recorded distingue les deux', () => {
    const db = treeDb();
    const sys = db.prepare('INSERT INTO system_samples(ts,mem_used_kb,mem_total_kb,swap_used_kb,swap_total_kb,psi_some10,load1,cpu_percent) VALUES (?,?,?,?,?,?,?,?)');
    sys.run(ts - 20 * M + 4000, 1, 1, 1, 1, null, 0, 0); // le service tournait, mais rien d'enregistré pour g
    expect(queryProcTree(db, 'g', ts - 20 * M, o)).toMatchObject({ procs: [], recorded: true });
    expect(queryProcTree(db, 'g', ts - 30 * M, o)).toMatchObject({ procs: [], recorded: false });
    db.prepare(
      'INSERT INTO system_minute(ts,mem_used_kb_avg,mem_used_kb_max,mem_total_kb,swap_used_kb_avg,swap_used_kb_max,swap_total_kb,psi_avg,psi_max,load1_avg,cpu_avg) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ).run(ts - 2 * M, 1, 1, 100, 0, 0, 100, 0, 0, 1, 1);
    expect(queryProcTree(db, 'g', ts - M - 20_000, opts(100 * H))).toMatchObject({ source: 'minute', procs: [], recorded: true });
    expect(queryProcTree(db, 'g', ts + 5 * M, opts(100 * H))).toMatchObject({ source: 'minute', procs: [], recorded: false });
  });

  test(`au plus ${PROC_TREE_MAX} processus (les plus gros), le reste compté dans omitted`, () => {
    const { db } = openTestDb(join(mkdtempSync(join(tmpdir(), 'pw-cap-')), 'm.db'));
    db.exec(`INSERT INTO groups(id,key,label,kind) VALUES (1,'g','g','app')`);
    const pr = db.prepare('INSERT INTO procs_in(id,pid,start_ticks,name,cmdline,group_id,ppid) VALUES (?,?,?,?,?,?,?)');
    const ps = db.prepare('INSERT INTO proc_samples VALUES (?,?,?,?,?)');
    db.exec('BEGIN');
    for (let i = 1; i <= PROC_TREE_MAX + 5; i++) {
      pr.run(i, i, 1, 'p', 'p', 1, 1);
      ps.run(ts, i, i, 0, 0);
    }
    db.exec('COMMIT');
    const r = queryProcTree(db, 'g', ts, o);
    expect(r.procs).toHaveLength(PROC_TREE_MAX);
    expect(r.omitted).toBe(5);
    expect(Math.min(...r.procs.map((p) => p.rssKB))).toBe(6);
  });

  test('hors rétention détaillée : ligne minute la plus proche, swap inconnu', () => {
    const db = treeDb();
    const pm = db.prepare('INSERT INTO proc_minute VALUES (?,?,?,?,?)');
    pm.run(ts - M, 1, 800, 900, 2);
    pm.run(ts, 1, 1100, 1300, 4);
    pm.run(ts + 3 * M, 2, 400, 400, 0); // hors de [minute − 1 min, minute + 1 min]
    db.exec('DELETE FROM proc_samples WHERE proc_id = 1');
    const r = queryProcTree(db, 'g', ts + 20_000, opts(100 * H));
    expect(r.source).toBe('minute');
    expect(r.procs).toEqual([{ pid: 10, startTicks: 1, ppid: 1, name: 'A', rssKB: 1100, swapKB: null, cpu: 4, sampleTs: ts, lastSeenTs: ts + 59_999 }]);
  });

  test('base v1 (procs sans ppid), lecture seule : ppid null', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'pw-v1t-')), 'm.db');
    const w = createV3Db(p); // schéma figé, ramené en v1
    w.exec(`INSERT INTO groups(id,key,label,kind) VALUES (1,'g','g','app');
            ALTER TABLE procs DROP COLUMN ppid;
            INSERT INTO procs(id,pid,start_ticks,name,cmdline,group_id) VALUES (1,10,1,'a','a',1);
            INSERT INTO proc_samples VALUES (1000,1,500,5,2);
            INSERT INTO proc_minute VALUES (0,1,505,600,2);
            PRAGMA user_version = 1;`);
    w.close();
    const { db } = openTestDb(p, { readOnly: true });
    expect(queryProcTree(db, 'g', 1000, { now: 2000, detailHours: 24, intervalSec: 5 }).procs[0]).toMatchObject({ pid: 10, ppid: null, swapKB: 5 });
    expect(queryProcTree(db, 'g', 1000, { now: 100 * H, detailHours: 24, intervalSec: 5 }).procs[0]).toMatchObject({ pid: 10, ppid: null, swapKB: null });
    db.close();
  });
});

describe('queryEvents filtré par groupe (alertes du détail)', () => {
  const D = 24 * H;
  const now = 10 * D;
  const t = now - H;
  /** g : proc 10 (échantillonné 30 s avant t), proc 11 (dernier échantillon 1 h avant t) ; h : proc 20. */
  function eventsDb() {
    const { db } = openTestDb(join(mkdtempSync(join(tmpdir(), 'pw-ev-')), 'm.db'));
    db.exec(`INSERT INTO groups(id,key,label,kind) VALUES (1,'g','G','app'), (2,'h','H','app');
             INSERT INTO procs_in(id,pid,start_ticks,name,cmdline,group_id) VALUES (1,10,1,'a','a',1), (2,11,1,'b','b',1), (3,20,1,'c','c',2), (4,30,1,'d','d',1);`);
    const ps = db.prepare('INSERT INTO proc_samples VALUES (?,?,?,?,?)');
    ps.run(t - 30_000, 1, 1000, 0, 1);
    ps.run(t - H, 2, 1000, 0, 1);
    ps.run(t - 30_000 + 10, 3, 1000, 0, 1);
    // proc 30 de g : seulement des agrégats minute, 3 jours avant
    db.prepare('INSERT INTO proc_minute VALUES (?,?,?,?,?)').run(t - 3 * D - 2 * M, 4, 1000, 1000, 1);
    const ev = db.prepare('INSERT INTO events(ts,type,group_id,detail) VALUES (?,?,?,?)');
    ev.run(t - 5 * M, 'pressure', null, '{"psi":30}');
    ev.run(t - 4 * M, 'leak', 1, '{"growthKB":1}');
    ev.run(t - 4 * M + 1, 'leak', 2, '{"growthKB":2}');
    ev.run(t - 3 * M, 'gap', null, '{"from":0,"to":1}');
    ev.run(t - 2 * M, 'tmpfs', null, '{"usedKB":1}');
    ev.run(t, 'earlyoom_kill', null, '{"pid":10,"name":"a"}');
    ev.run(t + 1, 'earlyoom_kill', null, '{"pid":20,"name":"c"}');
    ev.run(t + 2, 'earlyoom_kill', null, '{"pid":11,"name":"b"}');
    ev.run(t + 3, 'app_kill', null, '{"pids":[99,10],"signal":"SIGTERM"}');
    ev.run(t + 4, 'app_kill', 2, '{"pids":[20],"signal":"SIGTERM"}');
    ev.run(t + 5, 'app_kill', 1, '{"pids":[12345],"signal":"SIGTERM"}');
    ev.run(t - 3 * D, 'earlyoom_kill', null, '{"pid":30,"name":"d"}');
    ev.run(t + 6, 'earlyoom_kill', null, '{"pid":10,"name":"autre"}'); // pid de g vivant, mais nom différent : PID réutilisé
    ev.run(t + 7, 'app_kill', null, '{"pids":[10],"targets":[{"pid":10,"startTicks":1}],"signal":"SIGTERM"}');
    ev.run(t + 8, 'app_kill', null, '{"pids":[10],"targets":[{"pid":10,"startTicks":999}],"signal":"SIGTERM"}'); // autre processus
    ev.run(t + 9, 'app_kill', null, '{"pids":[11],"targets":[{"pid":11,"startTicks":1}],"signal":"SIGTERM"}'); // identité exacte, même sans échantillon récent
    return db;
  }
  const all = { from: 0, to: now };
  const sig = (db: DatabaseSync, key?: string) => queryEvents(db, all, key).map((e) => `${e.type}@${e.ts - t}`);

  test('groupe g : pressions, sa fuite, kills de ses processus vivants ; ni gap ni tmpfs', () => {
    expect(sig(eventsDb(), 'g')).toEqual([
      `earlyoom_kill@${-3 * D}`, // résolu via proc_minute
      `pressure@${-5 * M}`,
      `leak@${-4 * M}`,
      'earlyoom_kill@0', // pid 10 échantillonné 30 s avant
      'app_kill@3', // pids [99, 10]
      'app_kill@5', // group_id du groupe
      'app_kill@7', // identité pid + startTicks
      'app_kill@9',
    ]);
  });

  test('groupe h : son pid 20 ; pas le pid 10 de g', () => {
    expect(sig(eventsDb(), 'h')).toEqual([`pressure@${-5 * M}`, `leak@${-4 * M + 1}`, 'earlyoom_kill@1', 'app_kill@4']);
  });

  test('groupe inconnu : seulement les pressions ; sans groupe : tout, inchangé', () => {
    const db = eventsDb();
    expect(sig(db, 'inconnu')).toEqual([`pressure@${-5 * M}`]);
    expect(queryEvents(db, all)).toHaveLength(16);
    expect(queryEvents(db, all, undefined)).toEqual(queryEvents(db, all));
  });
});

describe('querySystem : Shmem et somme des groupes (découpage du Reste)', () => {
  test('détail : shmemKB = max du bucket, groupsKB = somme des groupes par bucket', () => {
    const { db } = seeded();
    db.exec('UPDATE system_samples SET shmem_kb = 1000 + ts / 5000');
    const s = querySystem(db, { from: 0, to: 10 * M }, opts(10 * M));
    expect(s.shmemKB.slice(0, 3)).toEqual([1000, 1001, 1002]);
    // Chrome (1000 Mo + 1 Mo par tick) + a (500 Mo)
    expect(s.groupsKB.slice(0, 2)).toEqual([1500 * 1024, 1501 * 1024]);
    expect(s.groupsKB).toHaveLength(s.ts.length);
  });

  test('minute : shmemKB = MAX(shmem_kb_max), groupsKB depuis mem_kb_max', () => {
    const { db } = seeded();
    db.exec('UPDATE system_minute SET shmem_kb_max = 7, shmem_kb_avg = 5');
    const s = querySystem(db, { from: 0, to: 30 * H }, opts(30 * H));
    expect(s.ts[0]).toBe(0);
    expect(s.shmemKB[0]).toBe(7);
    // bucket de 2 min (30 h de plage) : pic de Chrome = 1000 Mo + 23 Mo (24 ticks), a = 500 Mo
    expect(s.ts[1] - s.ts[0]).toBe(2 * M);
    expect(s.groupsKB[0]).toBe(1023 * 1024 + 500 * 1024);
  });

  test('heure : groupsKB = somme des pics horaires, shmemKB des heures', () => {
    const db = hourSeeded();
    db.exec('UPDATE system_hour SET shmem_kb_max = ts / 3600000');
    const now = 240 * H;
    const s = querySystem(db, rangeFromPreset('7d', now), opts(now));
    expect(s.shmemKB.at(-1)).toBe(239);
    expect(s.groupsKB.at(-1)).toBe(2000 + 239 + 300);
  });

  test('base v3 en lecture seule (colonnes shmem absentes) : shmemKB tout null, aucune exception', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pw-q-')), 'v3.db');
    const w = createV3Db(path);
    w.exec("INSERT INTO groups(id,key,label,kind) VALUES (1,'app:a','A','app')");
    for (let ts = 0; ts < 2 * M; ts += 5000) {
      w.prepare('INSERT INTO system_samples VALUES (?,?,?,?,?,?,?,?)').run(ts, 100, 1000, 0, 0, null, 0, 0);
      w.prepare('INSERT INTO group_samples VALUES (?,?,?,?,?,?)').run(ts, 1, 40, 2, 0, 1);
    }
    w.prepare('INSERT INTO system_minute VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(0, 1, 1, 8, 0, 0, 1, null, null, 0, 0);
    w.prepare('INSERT INTO system_hour VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(0, 1, 1, 8, 0, 0, 1, null, null, 0, 0);
    w.close();
    const { db } = openTestDb(path, { readOnly: true });
    const d = querySystem(db, { from: 0, to: 2 * M }, opts(2 * M));
    expect(d.ts.length).toBeGreaterThan(0);
    expect(d.shmemKB.every((v) => v === null)).toBe(true);
    expect(d.groupsKB[0]).toBe(42);
    for (const r of [{ from: 0, to: 30 * H }, { from: 0, to: 30 * 24 * H }]) {
      const s = querySystem(db, r, opts(r.to));
      expect(s.shmemKB.every((v) => v === null)).toBe(true);
    }
  });
});

test('historyCovers : premier agrégat ≤ since + 5 min et aucun trou depuis', () => {
  const { db } = seeded(); // minutes 0 à 9
  expect(historyCovers(db, 0, 10 * M)).toBe(true);
  expect(historyCovers(db, -5 * M, 10 * M)).toBe(true);
  expect(historyCovers(db, -6 * M, 10 * M)).toBe(false); // service plus récent que la période
  db.prepare("INSERT INTO events(ts,type,group_id,detail) VALUES (?, 'gap', NULL, '{}')").run(8 * M);
  expect(historyCovers(db, 0, 10 * M)).toBe(false);
  expect(historyCovers(db, 9 * M, 10 * M)).toBe(true); // trou avant la période
  const empty = openTestDb(join(mkdtempSync(join(tmpdir(), 'pw-q-')), 'e.db')).db;
  expect(historyCovers(empty, 0, M)).toBe(false);
});

test('queryRuleStats : rule_action + rule_dry_run des 7 derniers jours par ruleId ; plus vieux et sans ruleId ignorés', () => {
  const { db } = openTestDb(join(mkdtempSync(join(tmpdir(), 'pw-q-')), 'r.db'));
  const D = 86400_000;
  const now = 20 * D;
  const ins = (ts: number, type: string, detail: object | string) =>
    db.prepare('INSERT INTO events(ts,type,group_id,detail) VALUES (?,?,NULL,?)').run(ts, type, typeof detail === 'string' ? detail : JSON.stringify(detail));
  ins(now - 8 * D, 'rule_action', { ruleId: 'r-a', result: 'sigterm' });
  ins(now - 3 * D, 'rule_dry_run', { ruleId: 'r-a', result: 'dry_run' });
  ins(now - 2 * D, 'rule_dry_run', { ruleId: 'r-a', result: 'dry_run' });
  ins(now - 1 * D, 'rule_action', { ruleId: 'r-a', result: 'sigterm' });
  ins(now - 1 * D + 5000, 'rule_action', { ruleId: 'r-a', result: 'sigkill' }); // escalade : pas un déclenchement de plus
  ins(now - 1000, 'rule_action', { result: 'sigterm' });
  ins(now - 500, 'rule_dry_run', { ruleId: 'r-b', result: 'quota' });
  ins(now - 400, 'leak', { ruleId: 'r-b' });
  ins(now - 300, 'rule_action', 'pas du json');
  expect(queryRuleStats(db, now)).toEqual({
    'r-a': { lastTs: now - 1 * D, lastResult: 'sigterm', count7d: 3 },
    'r-b': { lastTs: now - 500, lastResult: 'quota', count7d: 0 },
  });
});

test('historyCovers : minutes manquantes (mise en veille, sans événement gap) → non couvert', () => {
  const { db } = seeded(); // minutes 0 à 9 seulement
  expect(historyCovers(db, 0, 10 * M)).toBe(true);
  expect(historyCovers(db, 0, 30 * M)).toBe(false); // 20 minutes sans agrégat
  db.prepare("INSERT INTO events(ts,type,group_id,detail) VALUES (?, 'gap', NULL, '{}')").run(99 * H); // trou daté dans le futur
  expect(historyCovers(db, 0, 10 * M)).toBe(false);
});

test('queryInactive : seuil d’activité réglable (max(1, procMinCpuPercent))', () => {
  const { db } = seeded(); // chrome : cpu 5 % à chaque échantillon
  const t = [{ pid: 10, startTicks: 100 }];
  expect(queryInactive(db, t, 0, opts(10 * M)).size).toBe(1);
  expect(queryInactive(db, t, 0, opts(10 * M), 5).size).toBe(1);
  expect(queryInactive(db, t, 0, opts(10 * M), 6).size).toBe(0);
});

describe('queryLastActive / historyFrom (vue swap)', () => {
  const D = 24 * H;
  /** p 30 : 5 % il y a 3 h (détail, minute agrégée) ; p 31 : 4 % il y a 3 j (minute seulement) ; p 32 : toujours 0,2 % ; p 33 : jamais enregistré. */
  function lastActiveDb() {
    const path = join(mkdtempSync(join(tmpdir(), 'pw-q-')), 'm.db');
    const { db } = openTestDb(path);
    const now = 10 * D;
    db.exec(`INSERT INTO groups(id,key,label,kind) VALUES (1,'project:/a','a','project');
             INSERT INTO procs_in(id,pid,start_ticks,name,cmdline,group_id) VALUES (1,30,300,'vite','vite',1), (2,31,310,'node','node',1), (3,32,320,'pg','pg',1);`);
    const ins = db.prepare('INSERT INTO proc_samples VALUES (?,?,?,?,?)');
    for (let ts = now - 4 * H; ts < now; ts += 5000) {
      // p 30 : 5 % pendant la minute qui précède « il y a 3 h » (dernier échantillon actif : now − 3 h − 5 s)
      ins.run(ts, 1, 1000, 0, ts >= now - 3 * H - M && ts < now - 3 * H ? 5 : 0);
      ins.run(ts, 3, 1000, 0, 0.2);
    }
    for (let m = now - 4 * H; m < now; m += M) aggregateMinute(db, m);
    const min = db.prepare('INSERT INTO proc_minute VALUES (?,?,?,?,?)');
    for (let ts = now - 5 * D; ts < now - 4 * H; ts += M) {
      min.run(ts, 2, 1000, 1000, ts === now - 3 * D ? 4 : 0);
      min.run(ts, 3, 1000, 1000, 0.2);
    }
    return { db, now };
  }
  const targets = [{ pid: 30, startTicks: 300 }, { pid: 31, startTicks: 310 }, { pid: 32, startTicks: 320 }, { pid: 33, startTicks: 330 }];

  test('dernier CPU ≥ 1 % : détail (ts exact), sinon minute (ts de la minute) ; jamais actif ou jamais enregistré → null', () => {
    const { db, now } = lastActiveDb();
    const r = queryLastActive(db, targets, 30 * D, { now, detailHours: 24, intervalSec: 5 });
    expect(r.get('30:300')).toBe(now - 3 * H - 5000);
    expect(r.get('31:310')).toBe(now - 3 * D);
    expect(r.get('32:320')).toBeNull();
    expect(r.get('33:330')).toBeNull();
    expect(r.size).toBe(4);
  });

  test('hors de la fenêtre lookback : null', () => {
    const { db, now } = lastActiveDb();
    const r = queryLastActive(db, targets, 2 * D, { now, detailHours: 24, intervalSec: 5 });
    expect(r.get('31:310')).toBeNull();
    expect(r.get('30:300')).toBe(now - 3 * H - 5000);
  });

  test('dans les 30 dernières minutes : détail directement ; détail purgé : début de la minute', () => {
    const { db, now } = lastActiveDb();
    db.prepare('UPDATE proc_samples SET cpu_percent = 2 WHERE proc_id = 3 AND ts = ?').run(now - 10 * M);
    const o = { now, detailHours: 24, intervalSec: 5 };
    expect(queryLastActive(db, targets, D, o).get('32:320')).toBe(now - 10 * M);
    db.exec('DELETE FROM proc_samples WHERE proc_id = 1');
    expect(queryLastActive(db, targets, D, o).get('30:300')).toBe(now - 3 * H - M);
  });

  test('cache : seules les minutes nouvelles sont relues ; activité nouvelle vue ; sortie de la fenêtre → null ; cibles disparues élaguées', () => {
    const { db, now } = lastActiveDb();
    const cache = new Map();
    const o = (t: number) => ({ now: t, detailHours: 24, intervalSec: 5 });
    const first = queryLastActive(db, targets, 30 * D, o(now), cache);
    expect(first.get('31:310')).toBe(now - 3 * D);
    expect(cache.get('31:310')).toEqual({ upTo: now - 30 * M, ts: now - 3 * D });
    // une ligne ajoutée avant `upTo` n'est pas relue (les minutes passées ne changent plus) : preuve que le cache sert
    db.prepare('UPDATE proc_minute SET cpu_avg = 9 WHERE proc_id = 2 AND ts = ?').run(now - 2 * D);
    expect(queryLastActive(db, targets, 30 * D, o(now + M), cache).get('31:310')).toBe(now - 3 * D);
    // activité nouvelle, dans une minute après `upTo` : vue
    db.prepare('INSERT INTO proc_minute VALUES (?,?,?,?,?)').run(now - 20 * M, 2, 1000, 1000, 3);
    expect(queryLastActive(db, targets, 30 * D, o(now + 15 * M), cache).get('31:310')).toBe(now - 20 * M);
    // fenêtre plus courte que l'âge de l'activité en cache : null
    const c2 = new Map();
    queryLastActive(db, [{ pid: 30, startTicks: 300 }], 30 * D, o(now), c2);
    expect(queryLastActive(db, [{ pid: 30, startTicks: 300 }], H, o(now), c2).get('30:300')).toBeNull();
    // cibles disparues : retirées du cache par l'appelant (lecture par tranches)
    pruneLastActiveCache(cache, new Set(['31:310']));
    expect([...cache.keys()]).toEqual(['31:310']);
    pruneLastActiveCache(cache, new Set());
    expect(cache.size).toBe(0);
  });

  test('seuil d\'activité passé en paramètre (max(1, procMinCpuPercent)) : 0,2 % compte sous un seuil de 0,1 %, 5 % ne compte pas sous 6 %', () => {
    const { db, now } = lastActiveDb();
    const o = { now, detailHours: 24, intervalSec: 5 };
    expect(queryLastActive(db, targets, D, o, undefined, 0.1).get('32:320')).not.toBeNull();
    expect(queryLastActive(db, targets, D, o, undefined, 6).get('30:300')).toBeNull();
  });

  test('aucune cible : carte vide', () => {
    const { db, now } = lastActiveDb();
    expect(queryLastActive(db, [], D, { now, detailHours: 24, intervalSec: 5 }).size).toBe(0);
  });

  test('historyFrom : base vide → null ; sinon le plus ancien instant des tables système détail / minute', () => {
    const { db } = openTestDb(join(mkdtempSync(join(tmpdir(), 'pw-q-')), 'm.db'));
    expect(historyFrom(db)).toBeNull();
    db.prepare('INSERT INTO system_samples(ts, mem_used_kb, mem_total_kb, swap_used_kb, swap_total_kb, psi_some10, load1, cpu_percent) VALUES (?,?,?,?,?,?,?,?)').run(5 * H, 1, 1, 0, 0, null, 0, 0);
    expect(historyFrom(db)).toBe(5 * H);
    db.prepare('INSERT INTO system_minute VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(2 * H, 1, 1, 8, 0, 0, 1, null, null, 0, 0, null, null);
    expect(historyFrom(db)).toBe(2 * H);
  });
});

describe('historyCoverage (vue swap : trous de l\'historique)', () => {
  const D = 24 * H;
  const now = 10 * D;
  function coverageDb(minutes: number[], latestDetail: number | null) {
    const { db } = openTestDb(join(mkdtempSync(join(tmpdir(), 'pw-q-')), 'm.db'));
    const ins = db.prepare('INSERT INTO system_minute VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const t of minutes) ins.run(t, 1, 1, 8, 0, 0, 1, null, null, 0, 0, null, null);
    if (latestDetail !== null)
      db.prepare('INSERT INTO system_samples(ts, mem_used_kb, mem_total_kb, swap_used_kb, swap_total_kb, psi_some10, load1, cpu_percent) VALUES (?,?,?,?,?,?,?,?)').run(latestDetail, 1, 1, 0, 0, null, 0, 0);
    return db;
  }
  const range = (from: number, to: number) => {
    const out: number[] = [];
    for (let t = from; t < to; t += M) out.push(t);
    return out;
  };

  test('base vide : rien', () => {
    expect(historyCoverage(coverageDb([], null), now - 7 * D, now)).toEqual({ latestTs: null, coveredFrom: null, gap: false });
  });

  test('continu sur 3 j, fenêtre 7 j : couvert depuis le début des données, sans trou', () => {
    const db = coverageDb(range(now - 3 * D, now - M), now - 3000);
    expect(historyCoverage(db, now - 7 * D, now)).toEqual({ latestTs: now - 3000, coveredFrom: now - 3 * D, gap: false });
  });

  test('continu sur 10 j : couverture bornée au début de la fenêtre', () => {
    const db = coverageDb(range(now - 10 * D, now - M), now - 3000);
    expect(historyCoverage(db, now - 7 * D, now)).toEqual({ latestTs: now - 3000, coveredFrom: now - 7 * D, gap: false });
  });

  test('service arrêté 20 h dans le dernier jour : couverture continue depuis la fin du trou, gap', () => {
    const db = coverageDb([...range(now - 3 * D, now - 24 * H), ...range(now - 4 * H, now - M)], now - 3000);
    expect(historyCoverage(db, now - 7 * D, now)).toEqual({ latestTs: now - 3000, coveredFrom: now - 4 * H, gap: true });
  });

  test('trou de 9 min toléré, trou de 11 min non', () => {
    const a = coverageDb([...range(now - 2 * D, now - D), ...range(now - D + 9 * M, now - M)], now - 3000);
    expect(historyCoverage(a, now - 7 * D, now).gap).toBe(false);
    const b = coverageDb([...range(now - 2 * D, now - D), ...range(now - D + 11 * M, now - M)], now - 3000);
    expect(historyCoverage(b, now - 7 * D, now)).toMatchObject({ coveredFrom: now - D + 11 * M, gap: true });
  });

  test('service arrêté maintenant : latestTs ancien (la fraîcheur est jugée par swapView)', () => {
    // la minute entamée du dernier échantillon est déjà agrégée (le service ré-agrège la minute en cours) : sa fin n'est pas un échantillon
    const db = coverageDb(range(now - 3 * D, now - 2 * H + M), now - 2 * H + 5000);
    expect(historyCoverage(db, now - 7 * D, now).latestTs).toBe(now - 2 * H + 5000);
  });
});
