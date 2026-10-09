import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openTestDb } from './testDb';
import { aggregateMinute } from './maintenance';
import { historyCoverage, queryInactive, queryLastActive } from './queries';

// Objectif < 20 ms, borne stricte 60 ms vérifiée avec PROC_WATCH_PERF=1 (`npm run test:recorder`, machine au repos).
// Dans `npm test` (suite parallèle, parfois à côté d'un build), borne 10 fois plus large : une vraie régression
// (index perdu, balayage complet de proc_samples) reste attrapée sans faux échec sous charge.
const SLACK = process.env.PROC_WATCH_PERF === '1' ? 1 : 10;
const H = 3600_000;
const M = 60_000;

// Cas le plus coûteux : 200 processus enregistrés et tous inactifs (CPU 0,5 %), aucun court-circuit possible.
test('performance : queryInactive, 200 processus inactifs sur 24 h à 5 s', () => {
  const { db } = openTestDb(join(mkdtempSync(join(tmpdir(), 'pw-perf-')), 'm.db'));
  const now = 100 * H;
  const start = now - 24 * H;
  const N = 200;
  db.exec('BEGIN');
  db.prepare("INSERT INTO groups(id,key,label,kind) VALUES (1,'project:/a','a','project')").run();
  const ps = db.prepare('INSERT INTO procs_in(id,pid,start_ticks,name,cmdline,group_id,ppid) VALUES (?,?,?,?,?,?,?)');
  for (let i = 1; i <= N; i++) ps.run(i, 1000 + i, 7, `p${i}`, `p${i}`, 1, 1);
  const pss = db.prepare('INSERT INTO proc_samples VALUES (?,?,?,?,?)');
  for (let ts = start; ts < now; ts += 5000) for (let i = 1; i <= N; i++) pss.run(ts, i, 1000, 0, 0.5);
  db.exec('COMMIT');
  for (let ts = start; ts < now; ts += M) aggregateMinute(db, ts);

  const targets = Array.from({ length: N }, (_, i) => ({ pid: 1001 + i, startTicks: 7 }));
  const o = { now, detailHours: 24, intervalSec: 5 };
  for (const [name, since] of [['1 h', now - H], ['24 h', start], ['24 h (2e)', start]] as const) {
    const t0 = performance.now();
    expect(queryInactive(db, targets, since, o).size).toBe(0);
    const ms = performance.now() - t0;
    console.info(`queryInactive ${name} (${N} procs): ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(60 * SLACK);
  }
}, 120_000);

// Vue swap : 100 processus endormis (CPU 0,5 %) sur 30 jours de minutes, plus 30 min de détail ; objectif < 50 ms, à froid
// comme avec le cache.
// 4,3 M lignes minute (~9 s de préparation, ~150 Mo dans le dossier temporaire) : seulement avec PROC_WATCH_PERF=1 (`npm run test:recorder`).
test.skipIf(process.env.PROC_WATCH_PERF !== '1')('performance : queryLastActive, 100 processus endormis sur 30 j de minutes', () => {
  const { db } = openTestDb(join(mkdtempSync(join(tmpdir(), 'pw-perf-')), 'm.db'));
  const D = 24 * H;
  const now = 40 * D;
  const N = 100;
  db.exec('BEGIN');
  db.prepare("INSERT INTO groups(id,key,label,kind) VALUES (1,'project:/a','a','project')").run();
  const ps = db.prepare('INSERT INTO procs_in(id,pid,start_ticks,name,cmdline,group_id,ppid) VALUES (?,?,?,?,?,?,?)');
  for (let i = 1; i <= N; i++) ps.run(i, 1000 + i, 7, `p${i}`, `p${i}`, 1, 1);
  const pm = db.prepare('INSERT INTO proc_minute VALUES (?,?,?,?,?)');
  for (let i = 1; i <= N; i++) for (let ts = now - 30 * D; ts < now; ts += M) pm.run(ts, i, 1000, 1000, 0.5);
  const pss = db.prepare('INSERT INTO proc_samples VALUES (?,?,?,?,?)');
  for (let i = 1; i <= N; i++) for (let ts = now - 30 * M; ts < now; ts += 5000) pss.run(ts, i, 1000, 0, 0.5);
  const sm = db.prepare('INSERT INTO system_minute VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (let ts = now - 30 * D; ts < now; ts += M) sm.run(ts, 1, 1, 8, 0, 0, 1, null, null, 0, 0, null, null);
  db.exec('COMMIT');
  const targets = Array.from({ length: N }, (_, i) => ({ pid: 1001 + i, startTicks: 7 }));
  const o = { now, detailHours: 24, intervalSec: 5 };
  // La vue swap lit au plus 7 j (SWAP_LOOKBACK_MS) quelle que soit la rétention : à froid ≈ 1 M lignes minute ; ensuite, le
  // cache ne relit que les minutes nouvelles. Le lecteur de l'app découpe en tranches de 25 (≈ 1/4 de ce temps d'affilée).
  const cache = new Map();
  for (const [name, at] of [['à froid, 7 j', now], ['avec cache, +30 s', now + 30_000], ['avec cache, +5 min', now + 5 * M]] as const) {
    const t0 = performance.now();
    const r = queryLastActive(db, targets, 7 * D, { ...o, now: at }, cache);
    const ms = performance.now() - t0;
    expect([...r.values()].every((v) => v === null)).toBe(true);
    console.info(`queryLastActive ${name} (${N} procs, 30 j enregistrés): ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(50 * SLACK);
  }
  // une tranche du lecteur de l'app (25 processus), à froid
  const t1 = performance.now();
  queryLastActive(db, targets.slice(0, 25), 7 * D, o, new Map());
  const chunk = performance.now() - t1;
  console.info(`queryLastActive tranche de 25, à froid: ${chunk.toFixed(1)} ms`);
  expect(chunk).toBeLessThan(20 * SLACK);
  const t2 = performance.now();
  const cov = historyCoverage(db, now - 7 * D, now);
  const covMs = performance.now() - t2;
  console.info(`historyCoverage 7 j: ${covMs.toFixed(1)} ms`);
  expect(cov.gap).toBe(false);
  expect(covMs).toBeLessThan(20 * SLACK);
}, 180_000);
