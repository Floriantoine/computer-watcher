import type { RecorderConfig } from './types';

/** Champs numériques de la section `recorder` et leurs bornes (source unique : config.ts et le formulaire des réglages). */
export type RecorderNumField = Exclude<keyof RecorderConfig, 'enabled'>;
export interface Bound { int: boolean; min: number; max?: number }

export const RECORDER_BOUNDS: Record<RecorderNumField, Bound> = {
  intervalSec: { int: true, min: 1, max: 60 },
  detailHours: { int: true, min: 1, max: 168 },
  summaryDays: { int: true, min: 1, max: 365 },
  procMinMemMB: { int: false, min: 0 },
  procMinCpuPercent: { int: false, min: 0 },
  groupMinMemMB: { int: false, min: 0, max: 1024 },
  leakMinMinutes: { int: true, min: 5, max: 24 * 60 },
  leakMinGrowthMB: { int: false, min: 0 },
  tmpfsAlertMB: { int: true, min: 100, max: 1_048_576 },
};

export function inBounds(v: unknown, b: Bound): v is number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < b.min) return false;
  if (b.max !== undefined && v > b.max) return false;
  return !b.int || Number.isInteger(v);
}
