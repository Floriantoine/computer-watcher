import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { SCHEMA_VERSION, openHistoryDb } from './db';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'pw-db-')), 'metrics.db');
const tables = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

test('création : tables, version, WAL, auto_vacuum incrémental', () => {
  const { db, recreated } = openHistoryDb(tmp());
  expect(recreated).toBeNull();
  expect(tables(db)).toEqual([
    'events', 'group_minute', 'group_samples', 'groups', 'proc_minute', 'proc_samples', 'procs', 'system_minute', 'system_samples',
  ]);
  expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
  expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
  expect((db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum).toBe(2);
  db.close();
});

test('réouverture : rien de recréé', () => {
  const p = tmp();
  openHistoryDb(p).db.close();
  const { db, recreated } = openHistoryDb(p);
  expect(recreated).toBeNull();
  db.close();
});

test('version inconnue → .bak-<date> et base neuve', () => {
  const p = tmp();
  const raw = new DatabaseSync(p);
  raw.exec('PRAGMA user_version = 99; CREATE TABLE x(a);');
  raw.close();
  const { db, recreated } = openHistoryDb(p, { now: () => Date.UTC(2026, 9, 7, 9, 40) });
  expect(recreated).toBe(`${p}.bak-20261007T094000`);
  expect(existsSync(recreated!)).toBe(true);
  expect(tables(db)).toContain('system_samples');
  db.close();
});

test('fichier corrompu → .bak et base neuve', () => {
  const p = tmp();
  writeFileSync(p, 'ceci n est pas une base sqlite, vraiment pas du tout');
  const { db, recreated } = openHistoryDb(p);
  expect(recreated).not.toBeNull();
  expect(tables(db)).toContain('events');
  db.close();
});

test('lecture seule : NO_DB si absente, lecture possible sinon', () => {
  const p = tmp();
  expect(() => openHistoryDb(p, { readOnly: true })).toThrow('NO_DB');
  openHistoryDb(p).db.close();
  const { db } = openHistoryDb(p, { readOnly: true });
  expect(() => db.exec('INSERT INTO events(ts,type) VALUES(1,"x")')).toThrow();
  db.close();
  expect(readdirSync(join(p, '..')).filter((f) => f.includes('.bak'))).toEqual([]);
});
