// src/core/history/queries.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openHistoryDb } from './db';
import { aggregateMinute } from './maintenance';
import { bucketMs, pickSource, queryInactive, queryCulprits, queryEvents, queryGroup, queryGroups, queryProcs, queryProcsAt, querySystem, queryTop, rangeFromPreset } from './queries';

const H = 3600_000;
const M = 60_000;
const opts = (now: number) => ({ now, detailHours: 24, intervalSec: 5 });

function seeded() {
  const path = join(mkdtempSync(join(tmpdir(), 'pw-q-')), 'm.db');
  const { db } = openHistoryDb(path);
  db.exec(`INSERT INTO groups(id,key,label,kind) VALUES (1,'app:chrome','Chrome','app'), (2,'project:/a','a','project');
           INSERT INTO procs(id,pid,start_ticks,name,cmdline,group_id) VALUES (1,10,100,'chrome','chrome',1);`);
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
  const { db } = openHistoryDb(path);
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
  const reader = openHistoryDb(path, { readOnly: true }).db;
  db.exec('BEGIN');
  db.prepare('INSERT INTO system_samples(ts, mem_used_kb, mem_total_kb, swap_used_kb, swap_total_kb, psi_some10, load1, cpu_percent) VALUES (?,?,?,?,?,?,?,?)').run(10 * M, 1, 1, 1, 1, null, 0, 0);
  expect(() => querySystem(reader, { from: 0, to: 11 * M }, opts(11 * M))).not.toThrow();
  db.exec('COMMIT');
  reader.close();
});

test('au plus 1000 points même quand from n\'est pas aligné sur le bucket', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pw-q-')), 'm.db');
  const { db } = openHistoryDb(path);
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
  db.exec(`INSERT INTO procs(id,pid,start_ticks,name,cmdline,group_id) VALUES (2,11,200,'chrome','chrome --type=renderer',1);`);
  for (let ts = 0; ts < 10 * M; ts += 5000) db.prepare('INSERT INTO proc_samples VALUES (?,?,?,?,?)').run(ts, 2, 300 * 1024, 0, 1);
  for (let m = 0; m < 10; m++) aggregateMinute(db, m * M);
  for (const range of [{ from: 0, to: 10 * M }, { from: 0, to: 30 * H }]) {
    const p = queryProcs(db, 'app:chrome', range, opts(10 * M));
    expect(p.series.map((s) => `${s.pid}:${s.startTicks}`).sort()).toEqual(['10:100', '11:200']);
    expect(p.series.find((s) => s.pid === 11)!.memKB.every((v) => v === 300 * 1024)).toBe(true);
  }
});

test('queryProcsAt : état à l\'instant demandé, mort/naissance, tri, repli minute', () => {
  const { db } = openHistoryDb(join(mkdtempSync(join(tmpdir(), 'pw-at-')), 'm.db'));
  db.exec(`INSERT INTO groups(id,key,label,kind) VALUES (1,'g','g','app');
           INSERT INTO procs(id,pid,start_ticks,name,cmdline,group_id,ppid) VALUES
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
  const w = openHistoryDb(p).db;
  w.exec(`INSERT INTO groups(id,key,label,kind) VALUES (1,'g','g','app');
          ALTER TABLE procs DROP COLUMN ppid;
          INSERT INTO procs(id,pid,start_ticks,name,cmdline,group_id) VALUES (1,10,1,'a','a',1);
          INSERT INTO proc_samples VALUES (1000,1,500,5,2);
          INSERT INTO proc_minute VALUES (0,1,505,600,2);
          PRAGMA user_version = 1;`);
  w.close();
  const { db } = openHistoryDb(p, { readOnly: true });
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
  const { db } = openHistoryDb(join(mkdtempSync(join(tmpdir(), 'pw-q-')), 'm.db'));
  db.exec(`INSERT INTO groups(id,key,label,kind) VALUES (1,'app:a','A','app'), (2,'others:small','Petits groupes','others');
           INSERT INTO procs(id,pid,start_ticks,name,cmdline,group_id) VALUES (1,10,100,'a','a',1);`);
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
  const { db: w } = openHistoryDb(path);
  w.exec(`DROP TABLE group_hour; DROP TABLE system_hour; PRAGMA user_version = 2;
          INSERT INTO groups(id,key,label,kind) VALUES (1,'app:a','A','app');`);
  for (let m = 0; m < 3; m++) {
    w.prepare('INSERT INTO group_minute VALUES (?,?,?,?,?,?)').run(100 * H + m * M, 1, 10, 0, 10, 0);
    w.prepare('INSERT INTO system_minute(ts, mem_used_kb_avg, mem_used_kb_max, mem_total_kb, swap_used_kb_avg, swap_used_kb_max, swap_total_kb, psi_avg, psi_max, load1_avg, cpu_avg) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(100 * H + m * M, 1, 1, 8, 0, 0, 1, null, null, 0, 0);
  }
  w.close();
  const { db } = openHistoryDb(path, { readOnly: true });
  const r = rangeFromPreset('7d', 101 * H);
  expect(querySystem(db, r, opts(101 * H)).ts.length).toBeGreaterThan(0);
  expect(queryTop(db, r, opts(101 * H)).byAvg.map((t) => t.key)).toEqual(['app:a']);
});

describe('queryInactive (« inactives depuis »)', () => {
  /** p 20 : CPU 5 % il y a 10 min, 0 % sinon ; p 21 : CPU 0,5 % ; p 22 : jamais enregistré. now = 2 h. */
  function inactiveDb() {
    const path = join(mkdtempSync(join(tmpdir(), 'pw-q-')), 'm.db');
    const { db } = openHistoryDb(path);
    db.exec(`INSERT INTO groups(id,key,label,kind) VALUES (1,'project:/a','a','project');
             INSERT INTO procs(id,pid,start_ticks,name,cmdline,group_id) VALUES (1,20,200,'vite','vite',1), (2,21,210,'node','node',1);`);
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
