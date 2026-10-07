// src/core/history/queries.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openHistoryDb } from './db';
import { aggregateMinute } from './maintenance';
import { bucketMs, pickSource, queryCulprits, queryEvents, queryGroup, queryGroups, queryProcs, queryProcsAt, querySystem, queryTop, rangeFromPreset } from './queries';

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
    db.prepare('INSERT INTO system_samples VALUES (?,?,?,?,?,?,?,?)').run(ts, chrome + 500 * 1024, 32_000_000, 100, 20_000_000, 2, 1, 10);
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

test('queryTop et queryEvents', () => {
  const { db } = seeded();
  const top = queryTop(db, { from: 0, to: 10 * M }, opts(10 * M));
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
  const byAvg = queryTop(db, r, opts(10 * M), { limit: 2 });
  const byMax = queryTop(db, r, opts(10 * M), { by: 'max', limit: 2 });
  expect(byAvg.map((t) => t.key)).toEqual(['app:chrome', 'project:/a']);
  expect(byMax.map((t) => t.key)).toEqual(['command:vitest', 'app:chrome']);
  expect(byMax[0].maxKB).toBe(2 * 1024 * 1024);
  // Sur une plage ancienne (agrégats minute), le pic survit grâce à mem_kb_max.
  const old = queryTop(db, r, opts(48 * H), { by: 'max', limit: 1 });
  expect(old.map((t) => [t.key, t.maxKB])).toEqual([['command:vitest', 2 * 1024 * 1024]]);
});

test('lecture seule pendant qu\'un écrivain tient une transaction : pas d\'erreur', () => {
  const { db, path } = seeded();
  const reader = openHistoryDb(path, { readOnly: true }).db;
  db.exec('BEGIN');
  db.prepare('INSERT INTO system_samples VALUES (?,?,?,?,?,?,?,?)').run(10 * M, 1, 1, 1, 1, null, 0, 0);
  expect(() => querySystem(reader, { from: 0, to: 11 * M }, opts(11 * M))).not.toThrow();
  db.exec('COMMIT');
  reader.close();
});

test('au plus 1000 points même quand from n\'est pas aligné sur le bucket', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pw-q-')), 'm.db');
  const { db } = openHistoryDb(path);
  db.exec('BEGIN');
  const ins = db.prepare('INSERT INTO system_samples VALUES (?,?,?,?,?,?,?,?)');
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
