import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openHistoryDb } from './db';
import {
  detectGap, formatAppEvent, ingestAppEvents, insertEvent, lastEventTs, lastSampleTs, parseAppEvents, parseEarlyoom, parseJournalLine, shouldRecordPressure,
} from './events';

test('parseEarlyoom : format récent avec uid', () => {
  expect(parseEarlyoom('sending SIGTERM to process 4242 uid 1000 "chrome": oom_score 600, VmRSS 1200 MiB, cmdline "/opt/chrome"')).toEqual({
    signal: 'SIGTERM', pid: 4242, uid: 1000, name: 'chrome',
  });
});

test('parseEarlyoom : ancien format sans uid, SIGKILL', () => {
  expect(parseEarlyoom('sending SIGKILL to process 77 "node": badness 900, VmRSS 3000 MiB')).toEqual({ signal: 'SIGKILL', pid: 77, uid: null, name: 'node' });
});

test('parseEarlyoom : autre ligne → null', () => {
  expect(parseEarlyoom('mem avail: 1200 of 31000 MiB')).toBeNull();
});

test('parseJournalLine', () => {
  expect(parseJournalLine(JSON.stringify({ __REALTIME_TIMESTAMP: '1791380400000000', MESSAGE: 'hello' }))).toEqual({ ts: 1791380400000, message: 'hello' });
  expect(parseJournalLine('pas du json')).toBeNull();
  expect(parseJournalLine(JSON.stringify({ MESSAGE: 'x' }))).toBeNull();
});

test('detectGap', () => {
  expect(detectGap(null, 100_000, 5)).toBeNull();
  expect(detectGap(100_000, 114_000, 5)).toBeNull();
  expect(detectGap(100_000, 116_000, 5)).toEqual({ from: 100_000, to: 116_000 });
});

test('shouldRecordPressure : ≥ 25 %, au plus une fois par minute', () => {
  expect(shouldRecordPressure(24.9, null, 0)).toBe(false);
  expect(shouldRecordPressure(null, null, 0)).toBe(false);
  expect(shouldRecordPressure(25, null, 0)).toBe(true);
  expect(shouldRecordPressure(40, 0, 59_999)).toBe(false);
  expect(shouldRecordPressure(40, 0, 60_000)).toBe(true);
});

test('app events : format, parse tolérant, ingestion qui vide le fichier', () => {
  const e = { ts: 5, type: 'app_kill' as const, groupKey: 'app:chrome', detail: { pids: [1, 2], signal: 'SIGTERM' } };
  const text = formatAppEvent(e) + 'ligne cassée\n' + JSON.stringify({ ts: 'x' }) + '\n';
  expect(parseAppEvents(text)).toEqual([e]);
  const dir = mkdtempSync(join(tmpdir(), 'pw-e-'));
  const p = join(dir, 'app-events.jsonl');
  expect(ingestAppEvents(p)).toEqual([]);
  writeFileSync(p, text);
  expect(ingestAppEvents(p)).toEqual([e]);
  expect(existsSync(p)).toBe(false);
  expect(existsSync(`${p}.ingest`)).toBe(false);
});

test('insertEvent résout le groupe ; lastSampleTs / lastEventTs', () => {
  const { db } = openHistoryDb(join(mkdtempSync(join(tmpdir(), 'pw-e-')), 'm.db'));
  db.exec(`INSERT INTO groups(id,key,label,kind) VALUES (7,'app:chrome','Chrome','app')`);
  insertEvent(db, 10, 'app_kill', 'app:chrome', { pids: [1] });
  insertEvent(db, 20, 'pressure', null, { psi: 30 });
  insertEvent(db, 30, 'earlyoom_kill', 'inconnu', { pid: 1 });
  expect(db.prepare('SELECT ts, type, group_id, detail FROM events ORDER BY ts').all()).toEqual([
    { ts: 10, type: 'app_kill', group_id: 7, detail: '{"pids":[1]}' },
    { ts: 20, type: 'pressure', group_id: null, detail: '{"psi":30}' },
    { ts: 30, type: 'earlyoom_kill', group_id: null, detail: '{"pid":1}' },
  ]);
  expect(lastEventTs(db, 'pressure')).toBe(20);
  expect(lastEventTs(db, 'leak')).toBeNull();
  expect(lastSampleTs(db)).toBeNull();
  db.exec('INSERT INTO system_samples VALUES (99,1,1,1,1,NULL,0,0)');
  expect(lastSampleTs(db)).toBe(99);
});
