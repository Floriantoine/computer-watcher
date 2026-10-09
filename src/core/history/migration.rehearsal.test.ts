// Répétition de la migration v5 sur une COPIE de la vraie base (opt-in : PROC_WATCH_REAL_DB=<chemin>).
// La vraie base n'est ouverte qu'en lecture seule ; les copies vont dans ~/.cache (jamais /tmp, en RAM) et sont supprimées.
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { SCHEMA_VERSION, hasColumn, openHistoryDb } from './db';
import {
  historyCoverage, queryCulprits, queryEvents, queryGroups, queryInactive, queryProcTree, queryProcs, queryProcsAt, querySystem, queryTop,
  rangeFromPreset,
} from './queries';

const REAL = process.env.PROC_WATCH_REAL_DB;
const TABLES = [
  'procs', 'proc_samples', 'proc_minute', 'groups', 'group_samples', 'group_minute', 'group_hour',
  'system_samples', 'system_minute', 'system_hour', 'events',
];
const counts = (db: DatabaseSync) =>
  Object.fromEntries(TABLES.map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]));
const version = (db: DatabaseSync) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} Mo`;
const fileSize = (p: string) => {
  let s = 0;
  for (const f of [p, `${p}-wal`]) {
    try {
      s += statSync(f).size;
    } catch {
      // pas de -wal
    }
  }
  return s;
};
/** Octets (dbstat) des tables et index de processus et de lignes de commande. */
const procBytes = (db: DatabaseSync) =>
  (db.prepare("SELECT COALESCE(SUM(pgsize), 0) AS s FROM dbstat WHERE name LIKE 'procs%' OR name LIKE 'cmdlines%' OR name LIKE 'sqlite_autoindex_procs%'").get() as { s: number }).s;
const procRows = (db: DatabaseSync) =>
  db.prepare(`SELECT p.id, p.pid, p.start_ticks, p.name, ${hasColumn(db, 'procs', 'cmdline') ? 'p.cmdline' : 'c.text'} AS cmdline, p.group_id, p.ppid
              FROM procs p ${hasColumn(db, 'procs', 'cmdline') ? '' : 'JOIN cmdlines c ON c.id = p.cmdline_id'} ORDER BY p.id`).all();

/** Requêtes de toutes les pistes (Métriques, détail de groupe, rejeu, coupables, swap, règles), à l'instant `now` de la copie. */
function snapshot(db: DatabaseSync, now: number) {
  const o = { now, detailHours: 24, intervalSec: 5 };
  const out: Record<string, unknown> = {};
  for (const preset of ['1h', '24h', '7d', '30d'] as const) {
    const r = rangeFromPreset(preset, now);
    const top = queryTop(db, r, o, { peakLimit: 8 });
    out[`system ${preset}`] = querySystem(db, r, o);
    out[`top ${preset}`] = top;
    out[`groups ${preset}`] = queryGroups(db, r, o, top.byMax.map((t) => t.key));
    out[`events ${preset}`] = queryEvents(db, r);
    for (const t of top.byMax.slice(0, 5)) {
      out[`events ${preset} ${t.key}`] = queryEvents(db, r, t.key);
      out[`procs ${preset} ${t.key}`] = queryProcs(db, t.key, r, o);
    }
  }
  const keys = (db.prepare('SELECT key FROM groups ORDER BY id').all() as { key: string }[]).map((g) => g.key);
  for (const ts of [now - 10 * 60_000, now - 6 * 3600_000, now - 3 * 86400_000]) {
    out[`culprits ${ts}`] = queryCulprits(db, ts, o);
    for (const key of keys.slice(0, 15)) {
      out[`tree ${key} ${ts}`] = queryProcTree(db, key, ts, o);
      out[`procsAt ${key} ${ts}`] = queryProcsAt(db, key, ts, o);
    }
  }
  out.coverage = historyCoverage(db, now - 7 * 86400_000, now);
  const pids = db.prepare('SELECT pid, start_ticks AS startTicks FROM procs ORDER BY id DESC LIMIT 200').all() as { pid: number; startTicks: number }[];
  out.inactive = [...queryInactive(db, pids, now - 3 * 3600_000, o)].sort();
  return out;
}

test.skipIf(!REAL)('répétition : migration v5 d’une copie de la vraie base (lecteur ouvert, échec forcé)', () => {
  const dir = mkdtempSync(join(homedir(), '.cache', 'pw-migr-'));
  const copy = join(dir, 'metrics.db');
  const failCopy = join(dir, 'fail', 'metrics.db');
  try {
    const src = new DatabaseSync(REAL!, { readOnly: true });
    const v0 = version(src);
    const t0 = performance.now();
    src.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
    const copyMs = performance.now() - t0;
    src.close();
    // VACUUM INTO écrit une base en journal classique : la remettre en WAL comme la vraie base (sinon un lecteur bloque l'écriture)
    const wal = new DatabaseSync(copy);
    wal.exec('PRAGMA journal_mode = WAL');
    wal.close();
    copyFileSync(copy, join(dir, 'v4.db')); // seconde copie (échec forcé), faite avant toute écriture
    const before = new DatabaseSync(copy, { readOnly: true });
    const now = (before.prepare('SELECT MAX(ts) AS t FROM system_samples').get() as { t: number }).t + 1;
    const countsBefore = counts(before);
    const rowsBefore = procRows(before);
    const procBytesBefore = procBytes(before);
    const distinct = (before.prepare('SELECT COUNT(DISTINCT cmdline) AS n FROM procs').get() as { n: number }).n;
    const tq = performance.now();
    const queriesBefore = snapshot(before, now);
    const queryMs = performance.now() - tq;
    before.close();
    const sizeBefore = fileSize(copy);

    // lecteur (l'app) ouvert pendant la migration, transaction de lecture en cours
    const reader = openHistoryDb(copy, { readOnly: true }).db;
    const it = reader.prepare('SELECT id FROM procs ORDER BY id').iterate();
    it.next();
    const t1 = performance.now();
    const { db, recreated, warning } = openHistoryDb(copy);
    const migrateMs = performance.now() - t1;
    expect(recreated).toBeNull();
    expect(warning).toBeNull();
    expect(version(db)).toBe(SCHEMA_VERSION);
    expect(hasColumn(db, 'procs', 'cmdline')).toBe(false);
    expect([...it].length).toBe(countsBefore.procs - 1); // le lecteur termine son instantané v4
    expect(snapshot(reader, now)).toEqual(queriesBefore); // puis lit la v5 sans être rouvert
    reader.close();
    expect(counts(db)).toEqual(countsBefore);
    expect((db.prepare('SELECT COUNT(*) AS n FROM cmdlines').get() as { n: number }).n).toBe(distinct);
    expect(procRows(db)).toEqual(rowsBefore);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    const sizeAfterMigration = fileSize(copy);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const procBytesAfter = procBytes(db);
    db.close();
    const sizeAfter = fileSize(copy);
    const fresh = openHistoryDb(copy, { readOnly: true }).db;
    expect(snapshot(fresh, now)).toEqual(queriesBefore);
    fresh.close();

    // échec forcé (vue nommée cmdlines) : la base reste v4, intacte et lisible
    mkdirSync(join(dir, 'fail'));
    renameSync(join(dir, 'v4.db'), failCopy);
    const raw = new DatabaseSync(failCopy);
    raw.exec('CREATE VIEW cmdlines AS SELECT 1 AS id, 2 AS text');
    raw.close();
    const t2 = performance.now();
    expect(() => openHistoryDb(failCopy)).toThrow(/cmdlines/);
    const failMs = performance.now() - t2;
    const after = openHistoryDb(failCopy, { readOnly: true }).db;
    expect(version(after)).toBe(v0);
    expect(hasColumn(after, 'procs', 'cmdline')).toBe(true);
    expect(counts(after)).toEqual(countsBefore);
    expect(snapshot(after, now)).toEqual(queriesBefore);
    after.close();

    console.log(
      [
        `version source : v${v0}`,
        `copie (VACUUM INTO) : ${copyMs.toFixed(0)} ms, ${mb(sizeBefore)}`,
        `migration v${v0} → v${SCHEMA_VERSION} (copie de sécurité .pre-v${SCHEMA_VERSION} comprise, lecteur ouvert) : ${migrateMs.toFixed(0)} ms`,
        `taille après migration : ${mb(sizeAfterMigration)} (fichier + -wal), après checkpoint : ${mb(sizeAfter)}`,
        `procs (+ cmdlines, index) : ${mb(procBytesBefore)} → ${mb(procBytesAfter)}`,
        `lignes de commande : ${countsBefore.procs} processus, ${distinct} distinctes`,
        `requêtes comparées : ${Object.keys(queriesBefore).length} (${queryMs.toFixed(0)} ms), identiques avant/après`,
        `échec forcé : ${failMs.toFixed(0)} ms, base restée v${v0}, requêtes identiques`,
        `lignes : ${JSON.stringify(countsBefore)}`,
      ].join('\n'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 600_000);
