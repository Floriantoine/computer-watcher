import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE system_samples (
  ts INTEGER PRIMARY KEY,
  mem_used_kb INTEGER NOT NULL, mem_total_kb INTEGER NOT NULL,
  swap_used_kb INTEGER NOT NULL, swap_total_kb INTEGER NOT NULL,
  psi_some10 REAL, load1 REAL NOT NULL, cpu_percent REAL NOT NULL
);
CREATE TABLE groups (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, label TEXT NOT NULL, kind TEXT NOT NULL);
CREATE TABLE group_samples (
  ts INTEGER NOT NULL, group_id INTEGER NOT NULL,
  rss_kb INTEGER NOT NULL, swap_kb INTEGER NOT NULL, cpu_percent REAL NOT NULL, proc_count INTEGER NOT NULL,
  PRIMARY KEY (group_id, ts)
) WITHOUT ROWID;
CREATE INDEX group_samples_ts ON group_samples(ts);
CREATE TABLE procs (
  id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, start_ticks INTEGER NOT NULL,
  name TEXT NOT NULL, cmdline TEXT NOT NULL, group_id INTEGER NOT NULL, ppid INTEGER,
  UNIQUE (pid, start_ticks)
);
CREATE INDEX procs_group ON procs(group_id);
CREATE TABLE proc_samples (
  ts INTEGER NOT NULL, proc_id INTEGER NOT NULL,
  rss_kb INTEGER NOT NULL, swap_kb INTEGER NOT NULL, cpu_percent REAL NOT NULL,
  PRIMARY KEY (proc_id, ts)
) WITHOUT ROWID;
CREATE INDEX proc_samples_ts ON proc_samples(ts);
CREATE TABLE system_minute (
  ts INTEGER PRIMARY KEY,
  mem_used_kb_avg REAL NOT NULL, mem_used_kb_max INTEGER NOT NULL, mem_total_kb INTEGER NOT NULL,
  swap_used_kb_avg REAL NOT NULL, swap_used_kb_max INTEGER NOT NULL, swap_total_kb INTEGER NOT NULL,
  psi_avg REAL, psi_max REAL, load1_avg REAL NOT NULL, cpu_avg REAL NOT NULL
);
CREATE TABLE group_minute (
  ts INTEGER NOT NULL, group_id INTEGER NOT NULL,
  rss_kb_avg REAL NOT NULL, swap_kb_avg REAL NOT NULL, mem_kb_max INTEGER NOT NULL, cpu_avg REAL NOT NULL,
  PRIMARY KEY (group_id, ts)
) WITHOUT ROWID;
CREATE INDEX group_minute_ts ON group_minute(ts);
CREATE TABLE proc_minute (
  ts INTEGER NOT NULL, proc_id INTEGER NOT NULL,
  mem_kb_avg REAL NOT NULL, mem_kb_max INTEGER NOT NULL, cpu_avg REAL NOT NULL,
  PRIMARY KEY (proc_id, ts)
) WITHOUT ROWID;
CREATE INDEX proc_minute_ts ON proc_minute(ts);
CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, type TEXT NOT NULL, group_id INTEGER, detail TEXT NOT NULL DEFAULT '{}');
CREATE INDEX events_ts ON events(ts);
`;

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 15);
}

function secure(path: string): void {
  for (const f of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(f)) chmodSync(f, 0o600);
  }
}

function removeOrphans(path: string): void {
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

function create(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 2000;');
  db.exec('PRAGMA auto_vacuum = INCREMENTAL;');
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec('BEGIN;' + SCHEMA + `PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
  secure(path);
  return db;
}

/** v1 -> v2 : ajoute procs.ppid (NULL pour l'historique existant). Idempotent, atomique. */
function migrateV1(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!hasColumn(db, 'procs', 'ppid')) db.exec('ALTER TABLE procs ADD COLUMN ppid INTEGER');
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

export function openHistoryDb(
  path: string,
  opts: { readOnly?: boolean; now?: () => number } = {},
): { db: DatabaseSync; recreated: string | null } {
  if (opts.readOnly) {
    if (!existsSync(path)) throw new Error('NO_DB');
    const db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000;');
    return { db, recreated: null };
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    removeOrphans(path);
    return { db: create(path), recreated: null };
  }
  let db: DatabaseSync | null = null;
  let empty = false;
  try {
    db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout = 2000;');
    const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    // v1 reconnue (table procs présente) : migration en place ; sinon traitée comme inconnue (.bak)
    const migratable = v === 1 && hasColumn(db, 'procs', 'id');
    if (migratable) {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
      migrateV1(db);
    }
    if (migratable || v === SCHEMA_VERSION) {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
      secure(path);
      return { db, recreated: null };
    }
    if (v === 0) {
      const n = (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get() as { n: number }).n;
      empty = n === 0;
    }
  } catch (e) {
    const code = (e as { errcode?: number }).errcode;
    if (code !== SQLITE_NOTADB && code !== SQLITE_CORRUPT) {
      db?.close();
      throw e; // erreur transitoire (BUSY, I/O, droits...) : ne jamais écarter une base saine
    }
  }
  db?.close();
  if (empty) {
    // fichier vide ou sans table (version 0) : rien à sauvegarder
    rmSync(path, { force: true });
    removeOrphans(path);
    return { db: create(path), recreated: null };
  }
  const bak = `${path}.bak-${stamp((opts.now ?? Date.now)())}`;
  renameSync(path, bak);
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(`${path}${ext}`)) renameSync(`${path}${ext}`, `${bak}${ext}`);
  }
  return { db: create(path), recreated: bak };
}
