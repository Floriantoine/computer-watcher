// src/main/history.ts
import { existsSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { historyBackups, openHistoryDb, SCHEMA_VERSION } from '../core/history/db';
import {
  queryCulprits, queryEvents, queryGroup, queryGroups, queryProcs, querySystem, queryTop, rangeFromPreset, type QueryOpts,
} from '../core/history/queries';
import { clearRequestPath, dbPath, statusPath } from '../core/paths';
import type { RangePreset, RecorderConfig, RecorderStatus, TimeRange, TopOptions, TopResult } from '../core/types';
import { clampToDetail } from './historyIpc';

export function createHistoryReader(dataDir: string, getConfig: () => RecorderConfig) {
  let db: DatabaseSync | null = null;
  let identity = '';
  const closeDb = (): void => {
    try {
      db?.close();
    } catch {
      // déjà fermée
    }
    db = null;
  };
  const conn = (): DatabaseSync | null => {
    const path = dbPath(dataDir);
    let id: string;
    try {
      const st = statSync(path);
      id = `${st.dev}:${st.ino}`;
    } catch {
      closeDb(); // pas (ou plus) de base
      return null;
    }
    if (db && id !== identity) closeDb(); // fichier remplacé par le service
    if (db) return db;
    try {
      db = openHistoryDb(path, { readOnly: true }).db;
      identity = id;
    } catch {
      db = null;
    }
    return db;
  };
  const opts = (): QueryOpts => ({ now: Date.now(), detailHours: getConfig().detailHours, intervalSec: getConfig().intervalSec });
  const toRange = (r: RangePreset | TimeRange): TimeRange => (typeof r === 'string' ? rangeFromPreset(r, Date.now()) : r);
  /** Exécute une requête ; en cas d'erreur (base recréée, verrou), ferme la connexion pour la rouvrir au prochain appel. */
  const run = <T>(fn: (d: DatabaseSync) => T, fallback: T): T => {
    const d = conn();
    if (!d) return fallback;
    try {
      return fn(d);
    } catch (e) {
      console.error('history:', e);
      closeDb();
      return fallback;
    }
  };
  return {
    system: (r: RangePreset | TimeRange) => run((d) => querySystem(d, toRange(r), opts()), null),
    groups: (r: RangePreset | TimeRange, keys?: string[]) => run((d) => queryGroups(d, toRange(r), opts(), keys), null),
    group: (key: string, r: RangePreset | TimeRange) => run((d) => queryGroup(d, key, toRange(r), opts()), null),
    procs: (key: string, r: RangePreset | TimeRange) =>
      run((d) => queryProcs(d, key, clampToDetail(toRange(r), Date.now(), getConfig().detailHours), opts()), null),
    culprits: (ts: number) => run((d) => queryCulprits(d, ts, opts()), []),
    top: (r: RangePreset | TimeRange, o?: TopOptions): TopResult => run((d) => queryTop(d, toRange(r), opts(), o), { byAvg: [], byMax: [] }),
    events: (r: RangePreset | TimeRange) => run((d) => queryEvents(d, toRange(r)), []),
    /** Ferme la connexion (avant suppression de la base). */
    close: closeDb,
    status: (): RecorderStatus | null => {
      try {
        return existsSync(statusPath(dataDir)) ? (JSON.parse(readFileSync(statusPath(dataDir), 'utf8')) as RecorderStatus) : null;
      } catch {
        return null;
      }
    },
  };
}

/** La base a-t-elle été créée par une version plus récente (le service l'ignore alors) ? */
function dbIsNewer(path: string): boolean {
  try {
    const { db } = openHistoryDb(path, { readOnly: true });
    try {
      return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version > SCHEMA_VERSION;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/**
 * « Vider l'historique ». Service actif (et base à sa version) : demande au service (`clear-request`), traitée à sa
 * prochaine minute. Sinon l'app supprime elle-même la base (+ -wal/-shm), recréée au prochain démarrage du service.
 * Les copies de sécurité (`.pre-vN-*`, `.bak-*`) sont supprimées dans tous les cas.
 */
export function clearHistory(
  dataDir: string,
  o: { running: boolean; beforeDelete?: () => void },
): { mode: 'deleted' | 'requested'; backups: number } {
  const path = dbPath(dataDir);
  const backups = historyBackups(path);
  for (const b of backups) rmSync(b.file, { force: true });
  const count = backups.filter((b) => !/-(wal|shm)$/.test(b.file)).length;
  if (o.running && !dbIsNewer(path)) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(clearRequestPath(dataDir), '');
    return { mode: 'requested', backups: count };
  }
  o.beforeDelete?.();
  for (const f of [path, `${path}-wal`, `${path}-shm`, clearRequestPath(dataDir)]) rmSync(f, { force: true });
  return { mode: 'deleted', backups: count };
}
