// src/core/history/maintenance.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openHistoryDb } from './db';
import { aggregateMinute, clearAll, leakCandidates, purge } from './maintenance';

const open = () => openHistoryDb(join(mkdtempSync(join(tmpdir(), 'pw-m-')), 'm.db')).db;
const M = 60_000;

function seed(db: ReturnType<typeof open>) {
  db.exec(`INSERT INTO groups(id,key,label,kind) VALUES (1,'app:chrome','Chrome','app');
           INSERT INTO procs(id,pid,start_ticks,name,cmdline,group_id) VALUES (1,10,100,'chrome','chrome',1);`);
  for (const [ts, mem] of [[0, 100], [5000, 300], [61_000, 1000]]) {
    db.prepare('INSERT INTO system_samples VALUES (?,?,?,?,?,?,?,?)').run(ts, mem, 4000, mem * 2, 8000, 1, 0.5, 10);
    db.prepare('INSERT INTO group_samples VALUES (?,?,?,?,?,?)').run(ts, 1, mem, 10, 5, 2);
    db.prepare('INSERT INTO proc_samples VALUES (?,?,?,?,?)').run(ts, 1, mem, 0, 5);
  }
}

test('aggregateMinute : moyenne et max de la minute, minute suivante intacte', () => {
  const db = open();
  seed(db);
  aggregateMinute(db, 0);
  expect(db.prepare('SELECT * FROM system_minute').all()).toEqual([
    { ts: 0, mem_used_kb_avg: 200, mem_used_kb_max: 300, mem_total_kb: 4000, swap_used_kb_avg: 400, swap_used_kb_max: 600, swap_total_kb: 8000, psi_avg: 1, psi_max: 1, load1_avg: 0.5, cpu_avg: 10 },
  ]);
  expect(db.prepare('SELECT * FROM group_minute').all()).toEqual([{ ts: 0, group_id: 1, rss_kb_avg: 200, swap_kb_avg: 10, mem_kb_max: 310, cpu_avg: 5 }]);
  expect(db.prepare('SELECT * FROM proc_minute').all()).toEqual([{ ts: 0, proc_id: 1, mem_kb_avg: 200, mem_kb_max: 300, cpu_avg: 5 }]);
  aggregateMinute(db, 0); // idempotent
  expect((db.prepare('SELECT COUNT(*) n FROM group_minute').get() as { n: number }).n).toBe(1);
});

test('aggregateMinute sur une minute vide : rien', () => {
  const db = open();
  aggregateMinute(db, 10 * M);
  expect(db.prepare('SELECT COUNT(*) n FROM system_minute').get()).toEqual({ n: 0 });
});

test('purge : détail > detailHours et résumés > summaryDays supprimés, orphelins retirés', () => {
  const db = open();
  seed(db);
  aggregateMinute(db, 0);
  const now = 2 * 3600_000; // 2 h plus tard
  purge(db, now, 1, 30);
  expect(db.prepare('SELECT COUNT(*) n FROM group_samples').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT COUNT(*) n FROM group_minute').get()).toEqual({ n: 1 });
  expect(db.prepare('SELECT COUNT(*) n FROM groups').get()).toEqual({ n: 1 });
  purge(db, 40 * 86400_000, 1, 30);
  expect(db.prepare('SELECT COUNT(*) n FROM group_minute').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT COUNT(*) n FROM groups').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT COUNT(*) n FROM procs').get()).toEqual({ n: 0 });
});

test('clearAll vide toutes les tables', () => {
  const db = open();
  seed(db);
  clearAll(db);
  for (const t of ['system_samples', 'groups', 'group_samples', 'procs', 'proc_samples', 'events']) {
    expect(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get()).toEqual({ n: 0 });
  }
});

test('leakCandidates : groupe en montée sur 61 minutes, pas deux fois dans l\'heure', () => {
  const db = open();
  db.exec(`INSERT INTO groups(id,key,label,kind) VALUES (1,'project:/a','a','project'), (2,'app:x','X','app');`);
  for (let i = 0; i <= 60; i++) {
    db.prepare('INSERT INTO group_minute VALUES (?,?,?,?,?,?)').run(i * M, 1, 1000 + i * 10 * 1024, 0, 0, 0);
    db.prepare('INSERT INTO group_minute VALUES (?,?,?,?,?,?)').run(i * M, 2, 5000, 0, 0, 0);
  }
  const now = 61 * M;
  expect(leakCandidates(db, now, 60, 300)).toEqual([{ groupId: 1, key: 'project:/a', label: 'a', growthKB: 600 * 1024 }]);
  db.prepare("INSERT INTO events(ts,type,group_id) VALUES (?, 'leak', 1)").run(now - 10 * M);
  expect(leakCandidates(db, now, 60, 300)).toEqual([]);
});

test('leakCandidates : now non aligné sur la minute', () => {
  const db = open();
  db.exec(`INSERT INTO groups(id,key,label,kind) VALUES (1,'project:/a','a','project');`);
  for (let i = 0; i <= 60; i++) db.prepare('INSERT INTO group_minute VALUES (?,?,?,?,?,?)').run(i * M, 1, 1000 + i * 10 * 1024, 0, 0, 0);
  expect(leakCandidates(db, 61 * M + 12_345, 60, 300)).toHaveLength(1);
});

test('purge : conserve les lignes encore référencées', () => {
  const db = open();
  db.exec(`INSERT INTO groups(id,key,label,kind) VALUES (1,'a','a','app'),(2,'b','b','app'),(3,'c','c','app');
           INSERT INTO procs(id,pid,start_ticks,name,cmdline,group_id) VALUES (1,1,1,'p','p',2),(2,2,2,'q','q',3);
           INSERT INTO events(ts,type,group_id) VALUES (1000000,'leak',1);
           INSERT INTO proc_samples VALUES (0,1,1,0,0);
           INSERT INTO proc_minute VALUES (0,2,1,1,0);`);
  purge(db, 2 * 3600_000, 1, 30);
  // proc 1 : samples purgés, plus de référence -> supprimé ; proc 2 : proc_minute -> gardé
  expect(db.prepare('SELECT id FROM procs').all()).toEqual([{ id: 2 }]);
  // groupe 1 : événement ; groupe 3 : procs 2 ; groupe 2 : orphelin
  expect(db.prepare('SELECT id FROM groups ORDER BY id').all()).toEqual([{ id: 1 }, { id: 3 }]);
});

test('clearAll vide aussi les tables minute', () => {
  const db = open();
  seed(db);
  aggregateMinute(db, 0);
  clearAll(db);
  for (const t of ['system_minute', 'group_minute', 'proc_minute']) {
    expect(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get()).toEqual({ n: 0 });
  }
});
