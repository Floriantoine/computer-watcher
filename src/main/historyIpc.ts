// src/main/historyIpc.ts — parties pures de l'IPC historique (validation, état du service)
import type { RangePreset, RecorderState, RecorderStatus, TimeRange } from '../core/types';

export const isRange = (r: unknown): r is RangePreset | TimeRange =>
  ['1h', '6h', '24h', '7d', '30d'].includes(r as string) ||
  (typeof r === 'object' && r !== null && Number.isFinite((r as TimeRange).from) && Number.isFinite((r as TimeRange).to));

export function recorderState(
  p: { available: boolean; enabled: boolean; intervalSec: number; status: RecorderStatus | null; now: number },
): RecorderState {
  const { status } = p;
  const running = !!status?.lastSampleAt && p.now - status.lastSampleAt < 3 * p.intervalSec * 1000 + 2000;
  return { available: p.available, enabled: p.enabled, running, status };
}
