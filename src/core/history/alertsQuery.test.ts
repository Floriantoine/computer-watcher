import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { countUnseenAlerts, newestAlertTs, queryAlert, queryAlertTimes, queryUnseenAlerts } from './alertsQuery';
import { ALERT_TYPES } from '../alerts';
import { openHistoryDb } from './db';
import { insertEvent } from './events';

const ALL = { types: ALERT_TYPES, exclude: [] };

function db() {
  const { db } = openHistoryDb(join(mkdtempSync(join(tmpdir(), 'pw-aq-')), 'm.db'));
  db.prepare("INSERT INTO groups(key, kind, label) VALUES ('project:/home/u/acme', 'project', 'acme')").run();
  return db;
}

test('alertes après seenUpTo seulement, types d’alerte seulement (gap, app_kill exclus), plus récentes d’abord, avec id et libellé de groupe', () => {
  const d = db();
  insertEvent(d, 1000, 'pressure', null, { psi: 30 });
  const leak = insertEvent(d, 2000, 'leak', 'project:/home/u/acme', { growthKB: 1, memKB: 2, minutes: 60 });
  insertEvent(d, 2500, 'gap', null, { from: 1, to: 2 });
  insertEvent(d, 2600, 'app_kill', null, { pids: [1], signal: 'SIGTERM' });
  const tmp = insertEvent(d, 3000, 'tmpfs', null, { shmemKB: 5, thresholdKB: 4 });
  expect(queryUnseenAlerts(d, 1000, ALL)).toEqual([
    { id: tmp, ts: 3000, type: 'tmpfs', groupKey: null, groupLabel: null, detail: { shmemKB: 5, thresholdKB: 4 } },
    { id: leak, ts: 2000, type: 'leak', groupKey: 'project:/home/u/acme', groupLabel: 'acme', detail: { growthKB: 1, memKB: 2, minutes: 60 } },
  ]);
  expect(queryUnseenAlerts(d, 3000, ALL)).toEqual([]);
});

test('limite : les plus récentes', () => {
  const d = db();
  for (let i = 1; i <= 5; i++) insertEvent(d, i * 1000, 'pressure', null, { psi: 30 + i });
  expect(queryUnseenAlerts(d, 0, { ...ALL, limit: 2 }).map((e) => e.ts)).toEqual([5000, 4000]);
});

test('queryAlert : par id ; id inconnu ou non-alerte → null ; détail illisible → {}', () => {
  const d = db();
  const id = insertEvent(d, 1000, 'earlyoom_kill', null, { name: 'chrome' });
  const gap = insertEvent(d, 1100, 'gap', null, {});
  d.prepare("INSERT INTO events(ts, type, detail) VALUES (1200, 'pressure', 'pas du json')").run();
  expect(queryAlert(d, id)).toMatchObject({ id, ts: 1000, type: 'earlyoom_kill', detail: { name: 'chrome' } });
  expect(queryAlert(d, gap)).toBeNull();
  expect(queryAlert(d, 999)).toBeNull();
  expect(queryUnseenAlerts(d, 1100, ALL)[0]!.detail).toEqual({});
});

test('filtres : types demandés seulement, ids exclus (fermés), compte sans limite', () => {
  const d = db();
  const ids: number[] = [];
  for (let i = 1; i <= 150; i++) ids.push(insertEvent(d, 1000 + i, 'pressure', null, { psi: 30 }));
  const leak = insertEvent(d, 5000, 'leak', null, {});
  insertEvent(d, 6000, 'gap', null, {});
  const opts = { types: ['pressure', 'leak'] as const, exclude: [ids[149]!, leak] };
  expect(countUnseenAlerts(d, 1000, opts)).toBe(149);
  expect(queryUnseenAlerts(d, 1000, { ...opts, limit: 100 })).toHaveLength(100);
  expect(queryUnseenAlerts(d, 1000, { ...opts, limit: 2 }).map((e) => e.id)).toEqual([ids[148], ids[147]]);
  expect(countUnseenAlerts(d, 1000, { types: ['leak'], exclude: [] })).toBe(1);
  expect(countUnseenAlerts(d, 1000, { types: [], exclude: [] })).toBe(0);
  expect(queryUnseenAlerts(d, 1000, { types: [], exclude: [] })).toEqual([]);
});

test('newestAlertTs (« Tout fermer ») et queryAlertTimes (élagage des ids vus)', () => {
  const d = db();
  const a = insertEvent(d, 1000, 'pressure', null, {});
  const b = insertEvent(d, 3000, 'leak', null, {});
  insertEvent(d, 9000, 'gap', null, {});
  expect(newestAlertTs(d, 0, { types: ['pressure', 'leak'], exclude: [] })).toBe(3000);
  expect(newestAlertTs(d, 0, { types: ['pressure'], exclude: [] })).toBe(1000);
  expect(newestAlertTs(d, 5000, { types: ['pressure', 'leak'], exclude: [] })).toBeNull();
  expect(queryAlertTimes(d, [a, b, 999])).toEqual(new Map([[a, 1000], [b, 3000]]));
  expect(queryAlertTimes(d, [])).toEqual(new Map());
});
