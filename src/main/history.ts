// src/main/history.ts
import { existsSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { openHistoryDb } from '../core/history/db';
import {
  queryCulprits, queryEvents, queryGroup, queryGroups, queryProcs, querySystem, queryTop, rangeFromPreset, type QueryOpts,
} from '../core/history/queries';
import { dbPath, statusPath } from '../core/paths';
import type { RangePreset, RecorderConfig, RecorderStatus, TimeRange } from '../core/types';

export function createHistoryReader(dataDir: string, getConfig: () => RecorderConfig) {
  let db: DatabaseSync | null = null;
  const conn = (): DatabaseSync | null => {
    if (db) return db;
    try {
      db = openHistoryDb(dbPath(dataDir), { readOnly: true }).db;
    } catch {
      db = null; // pas encore de base
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
      try {
        d.close();
      } catch {
        // déjà fermée
      }
      db = null;
      return fallback;
    }
  };
  return {
    system: (r: RangePreset | TimeRange) => run((d) => querySystem(d, toRange(r), opts()), null),
    groups: (r: RangePreset | TimeRange, keys?: string[]) => run((d) => queryGroups(d, toRange(r), opts(), keys), null),
    group: (key: string, r: RangePreset | TimeRange) => run((d) => queryGroup(d, key, toRange(r), opts()), null),
    procs: (key: string, r: RangePreset | TimeRange) => run((d) => queryProcs(d, key, toRange(r), opts()), null),
    culprits: (ts: number) => run((d) => queryCulprits(d, ts, opts()), []),
    top: (r: RangePreset | TimeRange) => run((d) => queryTop(d, toRange(r), opts()), []),
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
