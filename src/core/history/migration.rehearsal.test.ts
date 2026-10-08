// Répétition de la migration v4 sur une COPIE de la vraie base (opt-in : PROC_WATCH_REAL_DB=<chemin>).
// La vraie base n'est ouverte qu'en lecture seule ; la copie va dans ~/.cache (jamais /tmp, en RAM) et est supprimée.
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { SCHEMA_VERSION, hasColumn, openHistoryDb } from './db';

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

test.skipIf(!REAL)('répétition : migration v4 d’une copie de la vraie base', () => {
  const dir = mkdtempSync(join(homedir(), '.cache', 'pw-migr-'));
  const copy = join(dir, 'metrics.db');
  try {
    const src = new DatabaseSync(REAL!, { readOnly: true });
    const v0 = version(src);
    const t0 = performance.now();
    src.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
    const copyMs = performance.now() - t0;
    src.close();
    const before = new DatabaseSync(copy, { readOnly: true });
    const countsBefore = counts(before);
    before.close();
    const sizeBefore = fileSize(copy);

    const t1 = performance.now();
    const { db, recreated, warning } = openHistoryDb(copy);
    const migrateMs = performance.now() - t1;
    expect(recreated).toBeNull();
    expect(warning).toBeNull();
    expect(version(db)).toBe(SCHEMA_VERSION);
    expect(hasColumn(db, 'system_samples', 'shmem_kb')).toBe(true);
    expect(hasColumn(db, 'system_hour', 'shmem_kb_max')).toBe(true);
    expect(counts(db)).toEqual(countsBefore);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    db.close();
    const sizeAfter = fileSize(copy);

    console.log(
      [
        `version source : v${v0}`,
        `copie (VACUUM INTO) : ${copyMs.toFixed(0)} ms, ${mb(sizeBefore)}`,
        `migration (copie de sécurité .pre-v${SCHEMA_VERSION} comprise) : ${migrateMs.toFixed(0)} ms`,
        `taille après migration : ${mb(sizeAfter)}`,
        `lignes : ${JSON.stringify(countsBefore)}`,
      ].join('\n'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 600_000);
