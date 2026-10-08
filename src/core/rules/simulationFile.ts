// src/core/rules/simulationFile.ts — lecture et écriture atomique du crédit de Simulation (service → main).
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseSimStats, type SimStats } from './simulation';

/** null si le fichier est absent ou illisible (aucun crédit). */
export function readSimStatsFile(path: string): SimStats | null {
  try {
    return parseSimStats(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function writeSimStatsFile(path: string, stats: SimStats): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(stats), { mode: 0o600 });
  renameSync(tmp, path);
}
