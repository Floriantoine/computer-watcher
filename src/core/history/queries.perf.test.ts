import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openHistoryDb } from './db';
import { aggregateMinute } from './maintenance';
import { queryGroups, queryProcsAt, querySystem, queryTop, rangeFromPreset } from './queries';

// Objectifs réels (150 ms, 50 ms pour queryProcsAt) : vérifiés avec PROC_WATCH_PERF=1 (`npm run test:recorder`),
// sur une machine au repos. Dans `npm test`, la suite tourne en parallèle sur tous les cœurs (et parfois à côté d'un
// build) : les temps varient d'un facteur 3 à 5 sans régression. On garde donc une borne 10 fois plus large, qui
// attrape encore une vraie régression (index perdu, balayage complet : plusieurs secondes) sans échouer sous charge.
const STRICT = process.env.PROC_WATCH_PERF === '1';
const SLACK = STRICT ? 1 : 10;
const H = 3600_000;
const M = 60_000;

test('performance : 24 h x 100 groupes à 5 s', () => {
  const { db } = openHistoryDb(join(mkdtempSync(join(tmpdir(), 'pw-perf-')), 'm.db'));
  const now = 100 * H;
  const start = now - 24 * H;
  db.exec('BEGIN');
  const g = db.prepare('INSERT INTO groups(id,key,label,kind) VALUES (?,?,?,?)');
  for (let i = 1; i <= 100; i++) g.run(i, `app:g${i}`, `g${i}`, 'app');
  const sys = db.prepare('INSERT INTO system_samples(ts, mem_used_kb, mem_total_kb, swap_used_kb, swap_total_kb, psi_some10, load1, cpu_percent) VALUES (?,?,?,?,?,?,?,?)');
  const gs = db.prepare('INSERT INTO group_samples VALUES (?,?,?,?,?,?)');
  for (let ts = start; ts < now; ts += 5000) {
    sys.run(ts, 8_000_000, 32_000_000, 100, 20_000_000, 2, 1, 10);
    for (let i = 1; i <= 100; i++) gs.run(ts, i, 1000 * i + ((ts / 5000) % 50), 0, 1, 1);
  }
  db.exec('COMMIT');
  db.exec('BEGIN');
  const ps = db.prepare('INSERT INTO procs(id,pid,start_ticks,name,cmdline,group_id,ppid) VALUES (?,?,?,?,?,?,?)');
  const pss = db.prepare('INSERT INTO proc_samples VALUES (?,?,?,?,?)');
  for (let i = 1; i <= 100; i++) ps.run(i, 1000 + i, 1, `p${i}`, `p${i}`, 1, 1);
  for (let ts = start; ts < now; ts += 5000) for (let i = 1; i <= 100; i++) pss.run(ts, i, 1000 + i, 0, 1);
  db.exec('COMMIT');
  for (let ts = start; ts < now; ts += M) aggregateMinute(db, ts);

  const o = { now, detailHours: 24, intervalSec: 5 };
  const time = (name: string, fn: () => void) => {
    const t0 = performance.now();
    fn();
    const ms = performance.now() - t0;
    console.info(`${name}: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan((name.startsWith('queryProcsAt') ? 50 : 150) * SLACK);
  };
  time('queryGroups 24h', () => expect(queryGroups(db, rangeFromPreset('24h', now), o).series).toHaveLength(100));
  time('queryGroups 1h', () => expect(queryGroups(db, rangeFromPreset('1h', now), o).series).toHaveLength(100));
  time('queryGroups 6h', () => expect(queryGroups(db, rangeFromPreset('6h', now), o).series).toHaveLength(100));
  time('queryTop 6h', () => expect(queryTop(db, rangeFromPreset('6h', now), o).byAvg).toHaveLength(10));
  time('queryTop 24h', () => expect(queryTop(db, rangeFromPreset('24h', now), o).byAvg).toHaveLength(10));
  time('queryProcsAt détail (100 procs)', () => {
    expect(queryProcsAt(db, 'app:g1', now - 12 * H, o)).toHaveLength(100);
    expect(queryProcsAt(db, 'app:g1', now - 1, o)).toHaveLength(100);
  });
  time('queryProcsAt minute (100 procs)', () => expect(queryProcsAt(db, 'app:g1', now - 12 * H, { ...o, detailHours: 6 })).toHaveLength(100));
  time('querySystem 24h', () => expect(querySystem(db, rangeFromPreset('24h', now), o).ts.length).toBeGreaterThan(0));
}, 60_000);
