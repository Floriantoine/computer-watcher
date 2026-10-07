import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rollupHours } from './maintenance';

export const SCHEMA_VERSION = 3;

/** Tables horaires (v3) : sources des plages > 48 h, alimentées depuis les tables minute. */
const HOUR_SCHEMA = `
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
${HOUR_SCHEMA}`;

/** Connexion d'écriture : WAL, et journal WAL ramené à 64 Mo au plus après chaque checkpoint. */
const WRITER_PRAGMAS = 'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA journal_size_limit = 67108864;';

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 15);
}

const BACKUP_RE = /^\.(?:pre-v\d+|bak)-(\d{8}T\d{6})(?:-wal|-shm)?$/;

/** Copies de sécurité de la base (`.pre-vN-<date>`, `.bak-<date>`, avec leurs -wal/-shm) et leur date (UTC). */
export function historyBackups(path: string): { file: string; ts: number }[] {
  const prefix = basename(path);
  let names: string[];
  try {
    names = readdirSync(dirname(path));
  } catch {
    return [];
  }
  return names.flatMap((f) => {
    const m = f.startsWith(prefix) ? BACKUP_RE.exec(f.slice(prefix.length)) : null;
    if (!m) return [];
    const d = m[1];
    const ts = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(9, 11), +d.slice(11, 13), +d.slice(13, 15));
    return [{ file: join(dirname(path), f), ts }];
  });
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
  db.exec(WRITER_PRAGMAS);
  db.exec('BEGIN;' + SCHEMA + `PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
  secure(path);
  return db;
}

export type BackupFn = (db: DatabaseSync, dest: string) => void;

const vacuumInto: BackupFn = (db, dest) => db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);

/**
 * Copie de sécurité avant migration (0600) ; seule la plus récente (toutes versions) est conservée.
 * Au mieux : en cas d'échec (disque plein...), la copie partielle est supprimée et un avertissement renvoyé.
 */
function backupBeforeMigration(db: DatabaseSync, path: string, now: number, backup: BackupFn): string | null {
  const dest = `${path}.pre-v${SCHEMA_VERSION}-${stamp(now)}`;
  try {
    rmSync(dest, { force: true });
    backup(db, dest);
    chmodSync(dest, 0o600);
  } catch (e) {
    try {
      rmSync(dest, { force: true });
    } catch {
      // rien à supprimer
    }
    return `Copie de sécurité avant migration impossible (${(e as Error).message}) : migration effectuée sans copie`;
  }
  const prefix = `${basename(path)}.pre-v`;
  for (const f of readdirSync(dirname(path))) {
    if (f.startsWith(prefix) && join(dirname(path), f) !== dest) rmSync(join(dirname(path), f), { force: true });
  }
  return null;
}

/** v1 -> v2 : procs.ppid (NULL pour l'historique existant) ; v2 -> v3 : tables horaires remplies depuis les minutes. Idempotent, atomique. */
function migrate(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!hasColumn(db, 'procs', 'ppid')) db.exec('ALTER TABLE procs ADD COLUMN ppid INTEGER');
    db.exec(HOUR_SCHEMA);
    rollupHours(db);
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
  opts: { readOnly?: boolean; now?: () => number; backup?: BackupFn } = {},
): { db: DatabaseSync; recreated: string | null; warning: string | null } {
  if (opts.readOnly) {
    if (!existsSync(path)) throw new Error('NO_DB');
    const db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000;');
    return { db, recreated: null, warning: null };
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    removeOrphans(path);
    return { db: create(path), recreated: null, warning: null };
  }
  let db: DatabaseSync | null = null;
  let empty = false;
  try {
    db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout = 2000;');
    const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (v > SCHEMA_VERSION) {
      // base créée par une version plus récente : jamais écartée ni modifiée (retour arrière possible)
      throw Object.assign(new Error('HISTORY_DB_NEWER'), { code: 'HISTORY_DB_NEWER', version: v });
    }
    // v1/v2 reconnues (table procs présente) : migration en place ; sinon traitée comme inconnue (.bak)
    const migratable = (v === 1 || v === 2) && hasColumn(db, 'procs', 'id');
    let warning: string | null = null;
    if (migratable) {
      db.exec(WRITER_PRAGMAS);
      warning = backupBeforeMigration(db, path, (opts.now ?? Date.now)(), opts.backup ?? vacuumInto);
      migrate(db);
    }
    if (migratable || v === SCHEMA_VERSION) {
      db.exec(WRITER_PRAGMAS);
      secure(path);
      return { db, recreated: null, warning };
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
    return { db: create(path), recreated: null, warning: null };
  }
  const bak = `${path}.bak-${stamp((opts.now ?? Date.now)())}`;
  renameSync(path, bak);
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(`${path}${ext}`)) renameSync(`${path}${ext}`, `${bak}${ext}`);
  }
  return { db: create(path), recreated: bak, warning: null };
}
