// Tests seulement : base au schéma v3 exact (copie figée), pour les tests de migration et de lecture v3.
import { DatabaseSync } from 'node:sqlite';
import { openHistoryDb, registerCmdlineHash } from './db';

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

/** Base au schéma v4 exact (v3 + colonnes shmem ajoutées par ALTER, comme la migration v3 → v4), user_version = 4. */
export function createV4Db(path: string): DatabaseSync {
  const db = createV3Db(path);
  db.exec(`BEGIN;
    ALTER TABLE system_samples ADD COLUMN shmem_kb INTEGER;
    ALTER TABLE system_minute ADD COLUMN shmem_kb_avg REAL; ALTER TABLE system_minute ADD COLUMN shmem_kb_max INTEGER;
    ALTER TABLE system_hour ADD COLUMN shmem_kb_avg REAL; ALTER TABLE system_hour ADD COLUMN shmem_kb_max INTEGER;
    PRAGMA user_version = 4; COMMIT;`);
  return db;
}

/**
 * Vue temporaire `procs_in(id, pid, start_ticks, name, cmdline, group_id, ppid)` de cette connexion : une insertion y
 * dépose la ligne de commande dans `cmdlines` (v5) puis la ligne dans `procs` ; en v1–v4, dans `procs.cmdline`.
 * Les tests écrivent `INSERT INTO procs_in(...)` quel que soit le schéma. Idempotent.
 */
export function procsInput(db: DatabaseSync): DatabaseSync {
  const v5 = (db.prepare('PRAGMA table_info(procs)').all() as { name: string }[]).some((c) => c.name === 'cmdline_id');
  const ppid = (db.prepare('PRAGMA table_info(procs)').all() as { name: string }[]).some((c) => c.name === 'ppid');
  const cols = ppid ? 'id, pid, start_ticks, name, %C, group_id, ppid' : 'id, pid, start_ticks, name, %C, group_id';
  const vals = ppid ? 'NEW.id, NEW.pid, NEW.start_ticks, NEW.name, %V, NEW.group_id, NEW.ppid' : 'NEW.id, NEW.pid, NEW.start_ticks, NEW.name, %V, NEW.group_id';
  if (v5) registerCmdlineHash(db);
  db.exec(`DROP VIEW IF EXISTS temp.procs_in;
    CREATE TEMP VIEW procs_in(id, pid, start_ticks, name, cmdline, group_id, ppid) AS SELECT NULL, NULL, NULL, NULL, NULL, NULL, NULL;
    CREATE TEMP TRIGGER procs_in_insert INSTEAD OF INSERT ON procs_in BEGIN
      ${v5 ? `INSERT INTO cmdlines(hash, text) SELECT pw_cmdline_hash(NEW.cmdline), NEW.cmdline
               WHERE NOT EXISTS (SELECT 1 FROM cmdlines WHERE hash = pw_cmdline_hash(NEW.cmdline) AND text = NEW.cmdline);` : ''}
      INSERT INTO procs(${cols.replace('%C', v5 ? 'cmdline_id' : 'cmdline')})
        VALUES (${vals.replace('%V', v5 ? '(SELECT id FROM cmdlines WHERE hash = pw_cmdline_hash(NEW.cmdline) AND text = NEW.cmdline)' : 'NEW.cmdline')});
    END;`);
  return db;
}


/** openHistoryDb pour les tests : la connexion d'écriture reçoit la vue `procs_in`. */
export const openTestDb: typeof openHistoryDb = (p, opts) => {
  const r = openHistoryDb(p, opts);
  if (!opts?.readOnly) procsInput(r.db);
  return r;
};

/** Base au schéma v5 exact (schéma v6 sans les tables disque), user_version = 5. Connexion d'écriture. */
export function createV5Db(path: string): DatabaseSync {
  const { db } = openHistoryDb(path);
  db.exec(`BEGIN;
    DROP TABLE disk_samples; DROP TABLE disk_minute; DROP TABLE disk_hour;
    PRAGMA user_version = 5; COMMIT;`);
  return db;
}
