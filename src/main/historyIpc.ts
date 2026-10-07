// src/main/historyIpc.ts — parties pures de l'IPC historique (validation, état du service)
import type { RangePreset, RecorderState, RecorderStatus, TimeRange, TopOptions } from '../core/types';

export const isRange = (r: unknown): r is RangePreset | TimeRange =>
  ['1h', '6h', '24h', '7d', '30d'].includes(r as string) ||
  (typeof r === 'object' && r !== null && Number.isFinite((r as TimeRange).from) && Number.isFinite((r as TimeRange).to));

/** Options du top : absentes, ou `by` avg/max et `limit` entier de 1 à 50. */
export const isTopOptions = (o: unknown): o is TopOptions | undefined => {
  if (o === undefined) return true;
  if (typeof o !== 'object' || o === null) return false;
  const { by, limit } = o as TopOptions;
  return (by === undefined || by === 'avg' || by === 'max') && (limit === undefined || (Number.isInteger(limit) && limit >= 1 && limit <= 50));
};

export function recorderState(
  p: { available: boolean; enabled: boolean; intervalSec: number; status: RecorderStatus | null; now: number },
): RecorderState {
  const { status } = p;
  const running = !!status?.lastSampleAt && p.now - status.lastSampleAt < 3 * p.intervalSec * 1000 + 2000;
  return { available: p.available, enabled: p.enabled, running, status };
}
