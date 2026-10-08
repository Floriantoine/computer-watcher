import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openHistoryDb } from './db';
import { aggregateMinute } from './maintenance';
import { queryInactive } from './queries';

// Objectif < 20 ms, borne stricte 60 ms vérifiée avec PROC_WATCH_PERF=1 (`npm run test:recorder`, machine au repos).
// Dans `npm test` (suite parallèle, parfois à côté d'un build), borne 10 fois plus large : une vraie régression
// (index perdu, balayage complet de proc_samples) reste attrapée sans faux échec sous charge.
const SLACK = process.env.PROC_WATCH_PERF === '1' ? 1 : 10;
const H = 3600_000;
const M = 60_000;

// Cas le plus coûteux : 200 processus enregistrés et tous inactifs (CPU 0,5 %), aucun court-circuit possible.
test('performance : queryInactive, 200 processus inactifs sur 24 h à 5 s', () => {
  const { db } = openHistoryDb(join(mkdtempSync(join(tmpdir(), 'pw-perf-')), 'm.db'));
  const now = 100 * H;
  const start = now - 24 * H;
  const N = 200;
  db.exec('BEGIN');
  db.prepare("INSERT INTO groups(id,key,label,kind) VALUES (1,'project:/a','a','project')").run();
  const ps = db.prepare('INSERT INTO procs(id,pid,start_ticks,name,cmdline,group_id,ppid) VALUES (?,?,?,?,?,?,?)');
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
