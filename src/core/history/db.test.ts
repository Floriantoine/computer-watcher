import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  const first = openHistoryDb(p).db;
  first.exec("INSERT INTO events(ts,type) VALUES(42,'keep')");
  first.close();
  const { db, recreated } = openHistoryDb(p);
  expect(recreated).toBeNull();
  expect(db.prepare('SELECT ts FROM events').all()).toEqual([{ ts: 42 }]);
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
  const bak = new DatabaseSync(recreated!, { readOnly: true });
  expect(tables(bak)).toEqual(['x']);
  bak.close();
  expect(tables(db)).toContain('system_samples');
  db.close();
});

test('fichier corrompu → .bak et base neuve', () => {
  const p = tmp();
  const junk = 'ceci n est pas une base sqlite, vraiment pas du tout';
  writeFileSync(p, junk);
  const { db, recreated } = openHistoryDb(p);
  expect(recreated).not.toBeNull();
  expect(readFileSync(recreated!, 'utf8')).toBe(junk);
  expect(tables(db)).toContain('events');
  db.close();
});

test('lecture seule : NO_DB si absente, lecture possible sinon', () => {
  const p = tmp();
  const before = readdirSync(join(p, '..'));
  expect(() => openHistoryDb(p, { readOnly: true })).toThrow('NO_DB');
  expect(readdirSync(join(p, '..'))).toEqual(before);
  openHistoryDb(p).db.close();
  const { db } = openHistoryDb(p, { readOnly: true });
  expect(() => db.exec('INSERT INTO events(ts,type) VALUES(1,"x")')).toThrow();
  db.close();
  expect(readdirSync(join(p, '..')).filter((f) => f.includes('.bak'))).toEqual([]);
});

test('-wal/-shm orphelins sans metrics.db : ignorés, base neuve saine', () => {
  const p = tmp();
  writeFileSync(`${p}-wal`, 'orphelin');
  writeFileSync(`${p}-shm`, 'orphelin');
  const { db, recreated } = openHistoryDb(p);
  expect(recreated).toBeNull();
  expect(tables(db)).toContain('events');
  db.close();
});

test('fichier vide : recréé sans .bak', () => {
  const p = tmp();
  writeFileSync(p, '');
  const { db, recreated } = openHistoryDb(p);
  expect(recreated).toBeNull();
  expect(tables(db)).toContain('events');
  db.close();
  expect(readdirSync(join(p, '..')).filter((f) => f.includes('.bak'))).toEqual([]);
});

test('base écartée : -wal/-shm suivent la sauvegarde', () => {
  const p = tmp();
  const raw = new DatabaseSync(p);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA user_version = 99; CREATE TABLE x(a); INSERT INTO x VALUES(1);');
  // base laissée ouverte : -wal présent
  const { db, recreated } = openHistoryDb(p);
  expect(existsSync(`${recreated}-wal`)).toBe(true);
  const bak = new DatabaseSync(recreated!, { readOnly: true });
  expect(bak.prepare('SELECT a FROM x').all()).toEqual([{ a: 1 }]);
  bak.close();
  db.close();
  raw.close();
});

test('erreur non corruption (BUSY) : la base saine n’est jamais écartée', () => {
  const p = tmp();
  const raw = new DatabaseSync(p); // journal classique : un verrou exclusif bloque aussi la lecture
  raw.exec('PRAGMA user_version = 1; CREATE TABLE x(a);');
  raw.exec('BEGIN EXCLUSIVE');
  expect(() => openHistoryDb(p)).toThrow(/locked|busy/i);
  raw.exec('ROLLBACK');
  raw.close();
  expect(readdirSync(join(p, '..')).filter((f) => f.includes('.bak'))).toEqual([]);
  expect(existsSync(p)).toBe(true);
});

test('permissions : dossier 0700, fichiers 0600', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'pw-db-')), 'sub', 'metrics.db');
  const { db } = openHistoryDb(p);
  db.exec("INSERT INTO events(ts,type) VALUES(1,'x')");
  expect(statSync(join(p, '..')).mode & 0o777).toBe(0o700);
  expect(statSync(p).mode & 0o777).toBe(0o600);
  db.close();
  rmSync(join(p, '..'), { recursive: true });
});
