// src/main/historyIpc.ts — parties pures de l'IPC historique (validation, état du service)
import type { RangePreset, RecorderState, RecorderStatus, TimeRange, TopOptions } from '../core/types';

export const isRange = (r: unknown): r is RangePreset | TimeRange =>
  ['1h', '6h', '24h', '7d', '30d'].includes(r as string) ||
  (typeof r === 'object' && r !== null && Number.isFinite((r as TimeRange).from) && Number.isFinite((r as TimeRange).to));

/** Options du top : absentes, ou `limit` / `peakLimit` entiers de 1 à 50. */
export const isTopOptions = (o: unknown): o is TopOptions | undefined => {
  if (o === undefined) return true;
  if (typeof o !== 'object' || o === null) return false;
  const n = (v: unknown) => v === undefined || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 50);
  const { limit, peakLimit } = o as TopOptions;
  return n(limit) && n(peakLimit);
};

/** Clés de groupes demandées : absentes (tous les groupes), ou 1 à 50 clés texte. */
export const isGroupKeys = (k: unknown): k is string[] | undefined =>
  k === undefined || (Array.isArray(k) && k.length >= 1 && k.length <= 50 && k.every((x) => typeof x === 'string'));

/** Historique des processus : borné aux `detailHours` dernières heures (au-delà, une plage de 30 j parcourrait des millions de lignes). */
export function clampToDetail(r: TimeRange, now: number, detailHours: number): TimeRange {
  const from = Math.max(r.from, now - detailHours * 3600_000);
  return { from, to: Math.max(from, r.to) };
}

export function recorderState(
  p: { available: boolean; enabled: boolean; intervalSec: number; status: RecorderStatus | null; now: number },
): RecorderState {
  const { status } = p;
  const running = !!status?.lastSampleAt && p.now - status.lastSampleAt < 3 * p.intervalSec * 1000 + 2000;
  return { available: p.available, enabled: p.enabled, running, status };
}
