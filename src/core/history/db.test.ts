import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { SCHEMA_VERSION, historyBackups, openHistoryDb } from './db';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'pw-db-')), 'metrics.db');
const tables = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

test('création : tables, version, WAL, auto_vacuum incrémental, journal_size_limit', () => {
  const p = tmp();
  const { db, recreated } = openHistoryDb(p);
  expect(recreated).toBeNull();
  expect(tables(db)).toEqual([
    'events', 'group_hour', 'group_minute', 'group_samples', 'groups', 'proc_minute', 'proc_samples', 'procs', 'system_hour', 'system_minute',
    'system_samples',
  ]);
  expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
  expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
  expect((db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum).toBe(2);
  expect(db.prepare('PRAGMA journal_size_limit').get()).toEqual({ journal_size_limit: 67108864 });
  db.close();
  const again = openHistoryDb(p).db;
  expect(again.prepare('PRAGMA journal_size_limit').get()).toEqual({ journal_size_limit: 67108864 });
  again.close();
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

test('version ancienne non migrable → .bak-<date> et base neuve', () => {
  const p = tmp();
  const raw = new DatabaseSync(p);
  raw.exec('PRAGMA user_version = 1; CREATE TABLE x(a);');
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
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA user_version = 1; CREATE TABLE x(a); INSERT INTO x VALUES(1);');
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

test('migration v1 → v3 en place : lignes conservées, colonne ppid ajoutée (NULL)', () => {
  const p = tmp();
  const { db: v2 } = openHistoryDb(p);
  v2.exec("INSERT INTO groups(id,key,label,kind) VALUES (1,'g','g','app')");
  v2.exec('ALTER TABLE procs DROP COLUMN ppid'); // reconstitue le schéma v1
  v2.exec("INSERT INTO procs(id,pid,start_ticks,name,cmdline,group_id) VALUES (1,10,100,'a','a',1),(2,11,100,'b','b',1)");
  v2.exec('INSERT INTO proc_samples VALUES (5,1,10,0,1)');
  v2.exec('PRAGMA user_version = 1');
  v2.close();
  const { db, recreated } = openHistoryDb(p);
  expect(recreated).toBeNull();
  expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3);
  expect(db.prepare('SELECT id, pid, ppid FROM procs ORDER BY id').all()).toEqual([
    { id: 1, pid: 10, ppid: null }, { id: 2, pid: 11, ppid: null },
  ]);
  expect((db.prepare('SELECT COUNT(*) n FROM proc_samples').get() as { n: number }).n).toBe(1);
  expect(readdirSync(join(p, '..')).filter((f) => f.includes('.bak'))).toEqual([]);
  db.close();
  openHistoryDb(p).db.close(); // réouverture : idempotent
});

test('lecture seule sur une base v1 : ne migre pas, lit normalement', () => {
  const p = tmp();
  const { db: v2 } = openHistoryDb(p);
  v2.exec('ALTER TABLE procs DROP COLUMN ppid; PRAGMA user_version = 1');
  v2.close();
  const { db } = openHistoryDb(p, { readOnly: true });
  expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
  expect(db.prepare('SELECT * FROM procs').all()).toEqual([]);
  db.close();
});

test('version plus récente : erreur typée, fichier intact, pas de .bak, lecture seule possible', () => {
  const p = tmp();
  const raw = new DatabaseSync(p);
  raw.exec('PRAGMA user_version = 4; CREATE TABLE x(a); INSERT INTO x VALUES(1);');
  raw.close();
  const before = readFileSync(p);
  expect(() => openHistoryDb(p)).toThrow('HISTORY_DB_NEWER');
  try { openHistoryDb(p); } catch (e) { expect(e).toMatchObject({ code: 'HISTORY_DB_NEWER', version: 4 }); }
  expect(readFileSync(p).equals(before)).toBe(true);
  expect(readdirSync(join(p, '..')).filter((f) => f.includes('.bak'))).toEqual([]);
  const { db } = openHistoryDb(p, { readOnly: true });
  expect(db.prepare('SELECT a FROM x').all()).toEqual([{ a: 1 }]);
  db.close();
});

test('migration : copie pre-v3 valide (v1, 0600), seule la plus récente conservée', () => {
  const mkV1 = (p: string) => {
    const { db } = openHistoryDb(p);
    db.exec("INSERT INTO groups(id,key,label,kind) VALUES (1,'g','g','app')");
    db.exec('ALTER TABLE procs DROP COLUMN ppid');
    db.exec("INSERT INTO procs(id,pid,start_ticks,name,cmdline,group_id) VALUES (1,10,100,'a','a',1)");
    db.exec('PRAGMA user_version = 1');
    db.close();
  };
  const p = tmp();
  mkV1(p);
  openHistoryDb(p, { now: () => Date.UTC(2026, 9, 7, 9, 40) }).db.close();
  const first = `${p}.pre-v3-20261007T094000`;
  expect(existsSync(first)).toBe(true);
  expect(statSync(first).mode & 0o777).toBe(0o600);
  const c = new DatabaseSync(first, { readOnly: true });
  expect((c.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
  expect(c.prepare('SELECT pid FROM procs').all()).toEqual([{ pid: 10 }]);
  c.close();
  // seconde migration (base ramenée en v1) : l'ancienne copie est remplacée
  const d = new DatabaseSync(p);
  d.exec('ALTER TABLE procs DROP COLUMN ppid; PRAGMA user_version = 1');
  d.close();
  openHistoryDb(p, { now: () => Date.UTC(2026, 9, 8, 9, 40) }).db.close();
  expect(readdirSync(join(p, '..')).filter((f) => f.includes('.pre-v'))).toEqual([`${basename(p)}.pre-v3-20261008T094000`]);
});

const H = 3600_000;
/** Base v2 : schéma actuel sans les tables horaires. */
function makeV2(p: string, fill?: (db: DatabaseSync) => void) {
  const { db } = openHistoryDb(p);
  db.exec('DROP TABLE group_hour; DROP TABLE system_hour;');
  fill?.(db);
  db.exec('PRAGMA user_version = 2');
  db.close();
}
const n = (db: DatabaseSync, t: string) => (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;

test('migration v2 → v3 : tables horaires créées et remplies depuis les minutes, minutes conservées', () => {
  const p = tmp();
  makeV2(p, (db) => {
    db.exec("INSERT INTO groups(id,key,label,kind) VALUES (1,'a','a','app'),(2,'b','b','app')");
    const gm = db.prepare('INSERT INTO group_minute VALUES (?,?,?,?,?,?)');
    const sm = db.prepare('INSERT INTO system_minute VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    for (let m = 0; m < 120; m++) {
      const ts = 10 * H + m * 60_000;
      gm.run(ts, 1, 100 + m, 10, 200 + m, 1);
      if (m < 60) gm.run(ts, 2, 50, 0, 50, 2);
      sm.run(ts, 1000 + m, 2000 + m, 8000, 10, 20, 100, m < 60 ? null : 5, m < 60 ? null : 9, 1, 10);
    }
  });
  const { db, recreated, warning } = openHistoryDb(p, { now: () => Date.UTC(2026, 9, 7, 9, 40) });
  expect(recreated).toBeNull();
  expect(warning).toBeNull();
  expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3);
  expect(n(db, 'group_minute')).toBe(180);
  expect(db.prepare('SELECT * FROM group_hour ORDER BY group_id, ts').all()).toEqual([
    { ts: 10 * H, group_id: 1, rss_kb_avg: 129.5, swap_kb_avg: 10, mem_kb_max: 259, cpu_avg: 1 },
    { ts: 11 * H, group_id: 1, rss_kb_avg: 189.5, swap_kb_avg: 10, mem_kb_max: 319, cpu_avg: 1 },
    { ts: 10 * H, group_id: 2, rss_kb_avg: 50, swap_kb_avg: 0, mem_kb_max: 50, cpu_avg: 2 },
  ]);
  expect(db.prepare('SELECT ts, mem_used_kb_avg, mem_used_kb_max, psi_avg, psi_max FROM system_hour ORDER BY ts').all()).toEqual([
    { ts: 10 * H, mem_used_kb_avg: 1029.5, mem_used_kb_max: 2059, psi_avg: null, psi_max: null },
    { ts: 11 * H, mem_used_kb_avg: 1089.5, mem_used_kb_max: 2119, psi_avg: 5, psi_max: 9 },
  ]);
  const copy = `${p}.pre-v3-20261007T094000`;
  const c = new DatabaseSync(copy, { readOnly: true });
  expect((c.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2);
  expect(n(c, 'group_minute')).toBe(180);
  c.close();
  db.close();
  // réouverture : rien ne change (idempotent)
  const again = openHistoryDb(p);
  expect(n(again.db, 'group_hour')).toBe(3);
  again.db.close();
});

test('migration v2 → v3 : copie de sécurité impossible → avertissement, copie partielle supprimée, migration faite', () => {
  const p = tmp();
  makeV2(p);
  const { db, warning } = openHistoryDb(p, {
    now: () => Date.UTC(2026, 9, 7, 9, 40),
    backup: (_db, dest) => {
      writeFileSync(dest, 'partiel');
      throw new Error('disque plein');
    },
  });
  expect(warning).toMatch(/copie de sécurité.*disque plein/i);
  expect(readdirSync(join(p, '..')).filter((f) => f.includes('.pre-v'))).toEqual([]);
  expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3);
  expect(tables(db)).toContain('group_hour');
  db.close();
});

test('historyBackups : copies pre-vN et bak (avec -wal/-shm) datées, autres fichiers ignorés', () => {
  const p = tmp();
  for (const f of ['metrics.db.pre-v2-20261007T094000', 'metrics.db.bak-20261001T000000-wal', 'metrics.db.notes', 'metrics.db-wal', 'autre.db.bak-20261001T000000']) {
    writeFileSync(join(p, '..', f), '');
  }
  expect(historyBackups(p).sort((a, b) => a.ts - b.ts)).toEqual([
    { file: `${p}.bak-20261001T000000-wal`, ts: Date.UTC(2026, 9, 1) },
    { file: `${p}.pre-v2-20261007T094000`, ts: Date.UTC(2026, 9, 7, 9, 40) },
  ]);
});
