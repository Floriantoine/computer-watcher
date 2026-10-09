import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openHistoryDb } from './db';
import {
  detectGap, formatAppEvent, takeAppEvents, insertEvent, lastEventTs, lastSampleTs, parseAppEvents, parseEarlyoom, parseJournalLine, ruleEventsSince, shouldRecordPressure,
  shouldRecordTmpfs, type TmpfsAlertState,
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
  expect(parseJournalLine(JSON.stringify({ __REALTIME_TIMESTAMP: 'abc', MESSAGE: 'x' }))).toBeNull();
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

test('app events : format, parse validation stricte', () => {
  const e = { ts: 5, type: 'app_kill' as const, groupKey: 'app:chrome', detail: { pids: [1, 2], signal: 'SIGTERM' } };
  const text = formatAppEvent(e) + 'ligne cassée\n' + JSON.stringify({ ts: 'x' }) + '\n';
  expect(parseAppEvents(text)).toEqual([e]);
  // missing groupKey
  expect(parseAppEvents(JSON.stringify({ ts: 5, type: 'app_kill', detail: { pids: [1], signal: 'SIGTERM' } }))).toEqual([]);
  // numeric groupKey
  expect(parseAppEvents(JSON.stringify({ ts: 5, type: 'app_kill', groupKey: 5, detail: { pids: [1], signal: 'SIGTERM' } }))).toEqual([]);
  // non-numeric pid
  expect(parseAppEvents(JSON.stringify({ ts: 5, type: 'app_kill', groupKey: 'app:chrome', detail: { pids: ['x'], signal: 'SIGTERM' } }))).toEqual([]);
  // missing signal
  expect(parseAppEvents(JSON.stringify({ ts: 5, type: 'app_kill', groupKey: 'app:chrome', detail: { pids: [1] } }))).toEqual([]);
  // null line
  expect(parseAppEvents('null\n')).toEqual([]);
  // identités pid + startTicks conservées ; mal formées : ignorées (l'événement reste, avec ses pids)
  const withTargets = { ts: 5, type: 'app_kill', groupKey: null, detail: { pids: [1], signal: 'SIGTERM', targets: [{ pid: 1, startTicks: 42 }] } };
  expect(parseAppEvents(JSON.stringify(withTargets))).toEqual([withTargets]);
  const bad = { ...withTargets, detail: { ...withTargets.detail, targets: [{ pid: 1, startTicks: 'x' }] } };
  expect(parseAppEvents(JSON.stringify(bad))).toEqual([{ ...withTargets, detail: { pids: [1], signal: 'SIGTERM' } }]);
});

test('app events : earlyoom_setup (installation / activation depuis l’app), validation stricte', () => {
  const ok = { ts: 7, type: 'earlyoom_setup' as const, groupKey: null, detail: { mode: 'install' as const, ok: true, code: 0 } };
  const late = { ts: 8, type: 'earlyoom_setup' as const, groupKey: null, detail: { mode: 'activate' as const, ok: false, code: null, timedOut: true as const } };
  expect(parseAppEvents(formatAppEvent(ok) + formatAppEvent(late))).toEqual([ok, late]);
  // champs en trop écartés
  expect(parseAppEvents(JSON.stringify({ ...ok, detail: { ...ok.detail, cmd: 'rm -rf /' } }))).toEqual([ok]);
  for (const detail of [
    { mode: 'install; reboot', ok: true, code: 0 }, { mode: 'install', ok: 'oui', code: 0 }, { mode: 'install', ok: true, code: 'x' },
    { mode: 'install', ok: true, code: 1.5 }, { mode: 'install', ok: true }, null,
  ]) expect(parseAppEvents(JSON.stringify({ ts: 7, type: 'earlyoom_setup', groupKey: null, detail }))).toEqual([]);
  expect(parseAppEvents(JSON.stringify({ ...ok, groupKey: 'app:x' }))).toEqual([]);
});

test('app events : nettoyage de /tmp (tmp_clean), validé', () => {
  const e = { ts: 7, type: 'tmp_clean' as const, groupKey: null, detail: { freedKB: 2048, deleted: ['jest_rs'], refused: [{ name: 'x', reason: 'système' }] } };
  expect(parseAppEvents(formatAppEvent(e))).toEqual([e]);
  expect(parseAppEvents(JSON.stringify({ ...e, detail: { ...e.detail, freedKB: 'x' } }))).toEqual([]);
  expect(parseAppEvents(JSON.stringify({ ...e, detail: { ...e.detail, deleted: [1] } }))).toEqual([]);
  expect(parseAppEvents(JSON.stringify({ ...e, detail: { ...e.detail, refused: [{ name: 'x' }] } }))).toEqual([]);
  expect(parseAppEvents(JSON.stringify({ ...e, groupKey: 'app:x' }))).toEqual([]);
  // échec partiel : drapeau gardé s'il est booléen vrai
  const p = { ...e, detail: { ...e.detail, deleted: [], partial: true as const } };
  expect(parseAppEvents(formatAppEvent(p))).toEqual([p]);
  expect(parseAppEvents(JSON.stringify({ ...e, detail: { ...e.detail, partial: 'oui' } }))).toEqual([e]);
});

test('app events : ménage du disque (disk_clean), validé', () => {
  const e = { ts: 8, type: 'disk_clean' as const, groupKey: null, detail: { freedKB: 4096, done: ['npm'], refused: [{ id: 'uv', reason: 'utilisé par uv (pid 3)' }] } };
  expect(parseAppEvents(formatAppEvent(e))).toEqual([e]);
  expect(parseAppEvents(JSON.stringify({ ...e, detail: { ...e.detail, freedKB: 'x' } }))).toEqual([]);
  expect(parseAppEvents(JSON.stringify({ ...e, detail: { ...e.detail, done: [1] } }))).toEqual([]);
  expect(parseAppEvents(JSON.stringify({ ...e, detail: { ...e.detail, refused: [{ id: 'x' }] } }))).toEqual([]);
  expect(parseAppEvents(JSON.stringify({ ...e, groupKey: 'app:x' }))).toEqual([]);
});

test('takeAppEvents : flux normal, fichier vide après ack', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-e-'));
  const p = join(dir, 'app-events.jsonl');
  const e = { ts: 5, type: 'app_kill' as const, groupKey: 'app:chrome', detail: { pids: [1, 2], signal: 'SIGTERM' } };
  const text = formatAppEvent(e) + 'ligne cassée\n';

  // no file
  let result = takeAppEvents(p);
  expect(result.events).toEqual([]);
  expect(existsSync(p)).toBe(false);
  expect(existsSync(`${p}.ingest`)).toBe(false);

  // write file
  writeFileSync(p, text);

  // take events
  result = takeAppEvents(p);
  expect(result.events).toEqual([e]);
  expect(existsSync(p)).toBe(false); // original gone
  expect(existsSync(`${p}.ingest`)).toBe(true); // moved to .ingest

  // ack
  result.ack();
  expect(existsSync(`${p}.ingest`)).toBe(false); // deleted after ack
});

test('takeAppEvents : traite le .ingest laissé, laisse les nouveaux appends', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-e-'));
  const p = join(dir, 'app-events.jsonl');
  const e1 = { ts: 5, type: 'app_kill' as const, groupKey: 'app:chrome', detail: { pids: [1], signal: 'SIGTERM' } };
  const e2 = { ts: 10, type: 'app_kill' as const, groupKey: 'app:firefox', detail: { pids: [2], signal: 'SIGKILL' } };

  // leftover .ingest from crash
  writeFileSync(`${p}.ingest`, formatAppEvent(e1));

  // new appends meanwhile
  writeFileSync(p, formatAppEvent(e2));

  // take events
  const result = takeAppEvents(p);
  expect(result.events).toEqual([e1]); // from .ingest, not from p
  expect(existsSync(p)).toBe(true); // new appends stay
  expect(existsSync(`${p}.ingest`)).toBe(true);

  // ack
  result.ack();
  expect(existsSync(`${p}.ingest`)).toBe(false);
  expect(existsSync(p)).toBe(true); // new appends still there
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
  db.exec('INSERT INTO system_samples(ts, mem_used_kb, mem_total_kb, swap_used_kb, swap_total_kb, psi_some10, load1, cpu_percent) VALUES (99,1,1,1,1,NULL,0,0)');
  expect(lastSampleTs(db)).toBe(99);
});

const GB = 1_048_576;
const TMIN = 60_000;
const T = 2_097_152; // 2048 Mo
const fresh = (): TmpfsAlertState => ({ lastTs: null, armed: false, belowSince: null });

test('shouldRecordTmpfs : strictement au-dessus, au plus une fois par heure tant que ça dure', () => {
  const a = shouldRecordTmpfs(T + 1, T, fresh(), 0);
  expect(a).toEqual({ record: true, state: { lastTs: 0, armed: false, belowSince: null } });
  expect(shouldRecordTmpfs(T, T, fresh(), 0).record).toBe(false); // égal : pas « dépasse »
  expect(shouldRecordTmpfs(T + 1, T, a.state, 30 * TMIN).record).toBe(false);
  expect(shouldRecordTmpfs(T + 1, T, a.state, 61 * TMIN)).toMatchObject({ record: true, state: { lastTs: 61 * TMIN } });
  // redémarrage du service (dernier événement il y a 20 min, pas réarmée) : rien
  expect(shouldRecordTmpfs(T + 1, T, { lastTs: 100 * TMIN, armed: false, belowSince: null }, 120 * TMIN).record).toBe(false);
});

test('shouldRecordTmpfs : oscillation 1,93 ↔ 2,3 Go toutes les 5 s pendant 50 min → un seul événement', () => {
  let st = fresh();
  let n = 0;
  for (let t = 0, i = 0; t < 50 * TMIN; t += 5000, i++) {
    const r = shouldRecordTmpfs(i % 2 === 0 ? 2.3 * GB : 1.93 * GB, T, st, t);
    st = r.state;
    if (r.record) n++;
  }
  expect(n).toBe(1);
});

test('shouldRecordTmpfs : réarmée seulement après 5 min continues sous 90 % du seuil', () => {
  const fired = shouldRecordTmpfs(T + 1, T, fresh(), 0).state;
  const low = 0.85 * T;
  // 4 min sous 90 %, puis au-dessus : pas réarmée
  let st = fired;
  for (let t = TMIN; t <= 5 * TMIN; t += 5000) st = shouldRecordTmpfs(low, T, st, t).state;
  expect(shouldRecordTmpfs(T + 1, T, st, 5 * TMIN + 5000).record).toBe(false);
  // une remontée entre 90 % et le seuil remet le compteur à zéro
  st = fired;
  st = shouldRecordTmpfs(low, T, st, TMIN).state;
  st = shouldRecordTmpfs(0.95 * T, T, st, 3 * TMIN).state;
  st = shouldRecordTmpfs(low, T, st, 4 * TMIN).state;
  expect(shouldRecordTmpfs(T + 1, T, st, 7 * TMIN).record).toBe(false);
  // 5 min continues sous 90 % : réarmée, l'alerte repart dès le retour au-dessus
  st = fired;
  for (let t = TMIN; t <= 6 * TMIN; t += 5000) st = shouldRecordTmpfs(low, T, st, t).state;
  expect(st.armed).toBe(true);
  expect(shouldRecordTmpfs(T + 1, T, st, 6 * TMIN + 5000)).toMatchObject({ record: true, state: { armed: false } });
});

test('shouldRecordTmpfs : Shmem inconnu (null) → rien, état inchangé', () => {
  const st = { lastTs: 5, armed: true, belowSince: 3 };
  expect(shouldRecordTmpfs(null, T, st, 10)).toEqual({ record: false, state: st });
});

test('ruleEventsSince : rule_action et rule_dry_run depuis `since`, détail sans ruleId ignoré', () => {
  const { db } = openHistoryDb(join(mkdtempSync(join(tmpdir(), 'pw-ev-')), 'm.db'));
  const ins = (ts: number, type: string, detail: string) => db.prepare('INSERT INTO events(ts, type, group_id, detail) VALUES (?, ?, NULL, ?)').run(ts, type, detail);
  ins(5, 'rule_action', '{"ruleId":"r-a","result":"sigterm"}');
  ins(10, 'rule_dry_run', '{"ruleId":"r-b","result":"dry_run"}');
  ins(11, 'rule_action', '{"result":"sigterm"}');
  ins(12, 'forecast', '{"ruleId":"r-x","result":"x"}');
  ins(13, 'rule_action', 'pas du json');
  expect(ruleEventsSince(db, 10)).toEqual([{ ts: 10, type: 'rule_dry_run', ruleId: 'r-b', result: 'dry_run' }]);
  expect(ruleEventsSince(db, 0)).toHaveLength(2);
});
