import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openHistoryDb } from './db';
import { aggregateMinute } from './maintenance';
import { queryGroups, querySystem, queryTop, rangeFromPreset } from './queries';

const H = 3600_000;
const M = 60_000;

test('performance : 24 h x 100 groupes à 5 s', () => {
  const { db } = openHistoryDb(join(mkdtempSync(join(tmpdir(), 'pw-perf-')), 'm.db'));
  const now = 100 * H;
  const start = now - 24 * H;
  db.exec('BEGIN');
  const g = db.prepare('INSERT INTO groups(id,key,label,kind) VALUES (?,?,?,?)');
  for (let i = 1; i <= 100; i++) g.run(i, `app:g${i}`, `g${i}`, 'app');
  const sys = db.prepare('INSERT INTO system_samples VALUES (?,?,?,?,?,?,?,?)');
  const gs = db.prepare('INSERT INTO group_samples VALUES (?,?,?,?,?,?)');
  for (let ts = start; ts < now; ts += 5000) {
    sys.run(ts, 8_000_000, 32_000_000, 100, 20_000_000, 2, 1, 10);
    for (let i = 1; i <= 100; i++) gs.run(ts, i, 1000 * i + ((ts / 5000) % 50), 0, 1, 1);
  }
  db.exec('COMMIT');
  for (let ts = start; ts < now; ts += M) aggregateMinute(db, ts);

  const o = { now, detailHours: 24, intervalSec: 5 };
  const time = (name: string, fn: () => void) => {
    const t0 = performance.now();
    fn();
    const ms = performance.now() - t0;
    console.info(`${name}: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(150);
  };
  time('queryGroups 24h', () => expect(queryGroups(db, rangeFromPreset('24h', now), o).series).toHaveLength(100));
  time('queryGroups 1h', () => expect(queryGroups(db, rangeFromPreset('1h', now), o).series).toHaveLength(100));
  time('queryGroups 6h', () => expect(queryGroups(db, rangeFromPreset('6h', now), o).series).toHaveLength(100));
  time('queryTop 6h', () => expect(queryTop(db, rangeFromPreset('6h', now), o)).toHaveLength(10));
  time('queryTop 24h', () => expect(queryTop(db, rangeFromPreset('24h', now), o)).toHaveLength(10));
  time('querySystem 24h', () => expect(querySystem(db, rangeFromPreset('24h', now), o).ts.length).toBeGreaterThan(0));
}, 60_000);
