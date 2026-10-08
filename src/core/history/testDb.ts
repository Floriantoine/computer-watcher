// Tests seulement : base au schéma v3 exact (copie figée), pour les tests de migration et de lecture v3.
import { DatabaseSync } from 'node:sqlite';

const V3_SCHEMA = `
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
CREATE TABLE IF NOT EXISTS system_hour (
  ts INTEGER PRIMARY KEY,
  mem_used_kb_avg REAL NOT NULL, mem_used_kb_max INTEGER NOT NULL, mem_total_kb INTEGER NOT NULL,
  swap_used_kb_avg REAL NOT NULL, swap_used_kb_max INTEGER NOT NULL, swap_total_kb INTEGER NOT NULL,
  psi_avg REAL, psi_max REAL, load1_avg REAL NOT NULL, cpu_avg REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS group_hour (
  ts INTEGER NOT NULL, group_id INTEGER NOT NULL,
  rss_kb_avg REAL NOT NULL, swap_kb_avg REAL NOT NULL, mem_kb_max INTEGER NOT NULL, cpu_avg REAL NOT NULL,
  PRIMARY KEY (group_id, ts)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS group_hour_ts ON group_hour(ts);
`;

/** Base au schéma v3 exact (WAL, auto_vacuum incrémental, comme le service v3), user_version = 3. Connexion d'écriture. */
export function createV3Db(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL;');
  db.exec('BEGIN;' + V3_SCHEMA + 'PRAGMA user_version = 3; COMMIT;');
  return db;
}
