import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rollupHours } from './maintenance';

export const SCHEMA_VERSION = 6;

/** Tables horaires (v3) : sources des plages > 48 h, alimentées depuis les tables minute. Colonnes shmem : v4. */
const HOUR_SCHEMA = `
CREATE TABLE IF NOT EXISTS system_hour (
  ts INTEGER PRIMARY KEY,
  mem_used_kb_avg REAL NOT NULL, mem_used_kb_max INTEGER NOT NULL, mem_total_kb INTEGER NOT NULL,
  swap_used_kb_avg REAL NOT NULL, swap_used_kb_max INTEGER NOT NULL, swap_total_kb INTEGER NOT NULL,
  psi_avg REAL, psi_max REAL, load1_avg REAL NOT NULL, cpu_avg REAL NOT NULL,
  shmem_kb_avg REAL, shmem_kb_max INTEGER
);
CREATE TABLE IF NOT EXISTS group_hour (
  ts INTEGER NOT NULL, group_id INTEGER NOT NULL,
  rss_kb_avg REAL NOT NULL, swap_kb_avg REAL NOT NULL, mem_kb_max INTEGER NOT NULL, cpu_avg REAL NOT NULL,
  PRIMARY KEY (group_id, ts)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS group_hour_ts ON group_hour(ts);
`;

/**
 * Espace libre par partition surveillée (v6) : échantillons à chaque tick, agrégats par minute et par heure (libre au plus
 * bas et moyen). Clé (mount, ts) : séries par partition sans tri ; index ts pour la purge.
 */
const DISK_SCHEMA = `
CREATE TABLE IF NOT EXISTS disk_samples (
  ts INTEGER NOT NULL, mount TEXT NOT NULL, size_kb INTEGER NOT NULL, avail_kb INTEGER NOT NULL,
  PRIMARY KEY (mount, ts)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS disk_samples_ts ON disk_samples(ts);
CREATE TABLE IF NOT EXISTS disk_minute (
  ts INTEGER NOT NULL, mount TEXT NOT NULL, size_kb INTEGER NOT NULL, avail_kb_min INTEGER NOT NULL, avail_kb_avg REAL NOT NULL,
  PRIMARY KEY (mount, ts)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS disk_minute_ts ON disk_minute(ts);
CREATE TABLE IF NOT EXISTS disk_hour (
  ts INTEGER NOT NULL, mount TEXT NOT NULL, size_kb INTEGER NOT NULL, avail_kb_min INTEGER NOT NULL, avail_kb_avg REAL NOT NULL,
  PRIMARY KEY (mount, ts)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS disk_hour_ts ON disk_hour(ts);
`;

/**
 * Lignes de commande (v5), une fois chacune. Pas de contrainte UNIQUE sur text : son index recopierait chaque texte (mesuré :
 * cmdlines deux fois plus grosse, base plus grosse qu'en v4). L'unicité passe par un condensé indexé (hash, 6 octets) :
 * recherche `hash = ? AND text = ?`, collisions tolérées.
 */
const CMDLINES_SCHEMA = `
CREATE TABLE cmdlines (id INTEGER PRIMARY KEY, hash INTEGER NOT NULL, text TEXT NOT NULL);
CREATE INDEX cmdlines_hash ON cmdlines(hash);
`;

/** Condensé d'une ligne de commande (48 bits de SHA-256 : entier JS exact), colonne cmdlines.hash. */
export function cmdlineHash(text: string): number {
  return createHash('sha256').update(text).digest().readUIntBE(0, 6);
}

/** Déclare cmdlineHash en SQL (`pw_cmdline_hash`) sur cette connexion (migration, tests). */
export function registerCmdlineHash(db: DatabaseSync): void {
  db.function('pw_cmdline_hash', { deterministic: true }, (t) => cmdlineHash(String(t)));
}

/** procs v5 : la ligne de commande est une référence vers cmdlines (dédupliquée). */
function procsTable(name: string): string {
  return `CREATE TABLE ${name} (
  id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, start_ticks INTEGER NOT NULL,
  name TEXT NOT NULL, cmdline_id INTEGER NOT NULL, group_id INTEGER NOT NULL, ppid INTEGER,
  UNIQUE (pid, start_ticks)
);`;
}

/**
 * Index de procs (v5). procs_cmdline : purge des cmdlines orphelines sans parcours quadratique. procs_pid : couvrant pour
 * le filtre par groupe de queryEvents (pid ciblé → group_id, name, id sans lire la table).
 */
const PROCS_INDEXES = `
CREATE INDEX IF NOT EXISTS procs_group ON procs(group_id);
CREATE INDEX IF NOT EXISTS procs_cmdline ON procs(cmdline_id);
CREATE INDEX IF NOT EXISTS procs_pid ON procs(pid, group_id, name);
`;

const SCHEMA = `
CREATE TABLE system_samples (
  ts INTEGER PRIMARY KEY,
  mem_used_kb INTEGER NOT NULL, mem_total_kb INTEGER NOT NULL,
  swap_used_kb INTEGER NOT NULL, swap_total_kb INTEGER NOT NULL,
  psi_some10 REAL, load1 REAL NOT NULL, cpu_percent REAL NOT NULL,
  shmem_kb INTEGER
);
CREATE TABLE groups (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, label TEXT NOT NULL, kind TEXT NOT NULL);
CREATE TABLE group_samples (
  ts INTEGER NOT NULL, group_id INTEGER NOT NULL,
  rss_kb INTEGER NOT NULL, swap_kb INTEGER NOT NULL, cpu_percent REAL NOT NULL, proc_count INTEGER NOT NULL,
  PRIMARY KEY (group_id, ts)
) WITHOUT ROWID;
CREATE INDEX group_samples_ts ON group_samples(ts);
${CMDLINES_SCHEMA}
${procsTable('procs')}
${PROCS_INDEXES}
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
  psi_avg REAL, psi_max REAL, load1_avg REAL NOT NULL, cpu_avg REAL NOT NULL,
  shmem_kb_avg REAL, shmem_kb_max INTEGER
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
${HOUR_SCHEMA}
${DISK_SCHEMA}`;

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

/** Colonnes v4 (Shmem de /proc/meminfo, NULL avant leur ajout), dans l'ordre d'ajout. */
const SHMEM_COLUMNS: [table: string, column: string, type: string][] = [
  ['system_samples', 'shmem_kb', 'INTEGER'],
  ['system_minute', 'shmem_kb_avg', 'REAL'], ['system_minute', 'shmem_kb_max', 'INTEGER'],
  ['system_hour', 'shmem_kb_avg', 'REAL'], ['system_hour', 'shmem_kb_max', 'INTEGER'],
];

/**
 * v4 -> v5 : lignes de commande dédupliquées. cmdlines remplie depuis les valeurs distinctes, procs réécrite avec
 * cmdline_id (ids conservés : proc_samples et proc_minute restent valides), puis index. Dans la transaction de migrate.
 */
function dedupCmdlines(db: DatabaseSync): void {
  registerCmdlineHash(db);
  // une table seulement : un autre objet nommé cmdlines (vue...) fait échouer la migration, annulée en bloc
  if (!tableExists(db, 'cmdlines')) db.exec(CMDLINES_SCHEMA);
  db.exec(`INSERT INTO cmdlines(hash, text)
             SELECT pw_cmdline_hash(t), t FROM (SELECT DISTINCT cmdline AS t FROM procs)
             WHERE NOT EXISTS (SELECT 1 FROM cmdlines c WHERE c.hash = pw_cmdline_hash(t) AND c.text = t);
           DROP TABLE IF EXISTS procs_v5;
           ${procsTable('procs_v5')}
           INSERT INTO procs_v5(id, pid, start_ticks, name, cmdline_id, group_id, ppid)
             SELECT p.id, p.pid, p.start_ticks, p.name, c.id, p.group_id, p.ppid
             FROM procs p JOIN cmdlines c ON c.hash = pw_cmdline_hash(p.cmdline) AND c.text = p.cmdline;
           DROP TABLE procs;
           ALTER TABLE procs_v5 RENAME TO procs;`);
}

/**
 * v1 -> v2 : procs.ppid (NULL pour l'historique existant) ; v2 -> v3 : tables horaires remplies depuis les minutes ;
 * v3 -> v4 : colonnes shmem (ALTER TABLE ADD COLUMN, sans réécriture des tables) ; v4 -> v5 : table cmdlines, procs.cmdline_id
 * et index procs_cmdline, procs_pid ; v5 -> v6 : tables disque (vides). Idempotent, atomique : en cas d'échec, la base reste à sa version d'origine.
 */
function migrate(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!hasColumn(db, 'procs', 'ppid')) db.exec('ALTER TABLE procs ADD COLUMN ppid INTEGER');
    const hadHours = tableExists(db, 'system_hour') && tableExists(db, 'group_hour');
    db.exec(HOUR_SCHEMA);
    db.exec(DISK_SCHEMA);
    for (const [t, c, type] of SHMEM_COLUMNS) {
      if (!hasColumn(db, t, c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${type}`);
    }
    if (hasColumn(db, 'procs', 'cmdline')) dedupCmdlines(db);
    db.exec(PROCS_INDEXES);
    if (!hadHours) rollupHours(db); // v1/v2 seulement : une base v3 a déjà ses heures
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // rend la place de l'ancienne table procs, puis vide le journal WAL (un lecteur ouvert peut empêcher la troncature :
  // ce n'est pas une erreur, le journal sera recyclé plus tard)
  // Après la validation, la base est déjà une v6 valide : un échec ici ne doit pas faire planter le démarrage.
  try {
    db.exec('PRAGMA incremental_vacuum;');
    db.exec('PRAGMA busy_timeout = 0;'); // sans attendre le lecteur : busy = 1 dans le résultat, pas une erreur
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {
    // place et journal récupérés plus tard (purge périodique, checkpoint automatique)
  } finally {
    db.exec('PRAGMA busy_timeout = 2000;');
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
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
    // v1 à v5 reconnues (table procs présente) : migration en place ; sinon traitée comme inconnue (.bak)
    const migratable = v >= 1 && v < SCHEMA_VERSION && hasColumn(db, 'procs', 'id');
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
