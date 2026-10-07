// src/main/history.ts
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { openHistoryDb } from '../core/history/db';
import {
  queryCulprits, queryEvents, queryGroup, queryGroups, queryProcs, querySystem, queryTop, rangeFromPreset, type QueryOpts,
} from '../core/history/queries';
import { dbPath, statusPath } from '../core/paths';
import type { RangePreset, RecorderConfig, RecorderStatus, TimeRange, TopOptions } from '../core/types';

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
    procs: (key: string, r: RangePreset | TimeRange) => run((d) => queryProcs(d, key, toRange(r), opts()), null),
    culprits: (ts: number) => run((d) => queryCulprits(d, ts, opts()), []),
    top: (r: RangePreset | TimeRange, o?: TopOptions) => run((d) => queryTop(d, toRange(r), opts(), o), []),
    events: (r: RangePreset | TimeRange) => run((d) => queryEvents(d, toRange(r)), []),
    status: (): RecorderStatus | null => {
      try {
        return existsSync(statusPath(dataDir)) ? (JSON.parse(readFileSync(statusPath(dataDir), 'utf8')) as RecorderStatus) : null;
      } catch {
        return null;
      }
    },
  };
}
