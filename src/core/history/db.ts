import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;

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
  name TEXT NOT NULL, cmdline TEXT NOT NULL, group_id INTEGER NOT NULL,
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

function create(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA auto_vacuum = INCREMENTAL;');
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec('BEGIN;' + SCHEMA + `PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
  return db;
}

function tune(db: DatabaseSync): void {
  db.exec('PRAGMA busy_timeout = 2000;');
}

export function openHistoryDb(
  path: string,
  opts: { readOnly?: boolean; now?: () => number } = {},
): { db: DatabaseSync; recreated: string | null } {
  if (opts.readOnly) {
    if (!existsSync(path)) throw new Error('NO_DB');
    const db = new DatabaseSync(path, { readOnly: true });
    tune(db);
    return { db, recreated: null };
  }
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    const db = create(path);
    tune(db);
    return { db, recreated: null };
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path);
    const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (v === SCHEMA_VERSION) {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
      tune(db);
      return { db, recreated: null };
    }
  } catch {
    // fichier illisible ou corrompu : traité comme une version inconnue
  }
  db?.close();
  const bak = `${path}.bak-${stamp((opts.now ?? Date.now)())}`;
  renameSync(path, bak);
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
  const fresh = create(path);
  tune(fresh);
  return { db: fresh, recreated: bak };
}
