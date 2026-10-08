// Seuils d'earlyoom (SIGTERM, -m / -s) pour la prévision ② : lus dans /etc/default/earlyoom avec le parseur des
// Réglages › earlyoom (src/core/earlyoom.ts), repli 8 % / 35 % si le fichier est absent, illisible ou sans EARLYOOM_ARGS.
import { readFileSync } from 'node:fs';
import { parseEarlyoomDefault } from '../earlyoom';

export interface EarlyoomThresholds {
  /** Seuil SIGTERM mémoire disponible (% de MemTotal). */
  memPercent: number;
  /** Seuil SIGTERM swap libre (% de SwapTotal). */
  swapPercent: number;
  source: 'file' | 'default';
}

export const DEFAULT_THRESHOLDS: EarlyoomThresholds = Object.freeze({ memPercent: 8, swapPercent: 35, source: 'default' as const });
export const EARLYOOM_DEFAULTS_FILE = '/etc/default/earlyoom';

const inRange = (v: number) => Number.isFinite(v) && v > 0 && v <= 100;

export function parseEarlyoomThresholds(text: string | null): EarlyoomThresholds {
  const parsed = text ? parseEarlyoomDefault(text) : null;
  if (!parsed) return { ...DEFAULT_THRESHOLDS };
  const { memTerm, swapTerm } = parsed.settings;
  return {
    memPercent: inRange(memTerm) ? memTerm : DEFAULT_THRESHOLDS.memPercent,
    swapPercent: inRange(swapTerm) ? swapTerm : DEFAULT_THRESHOLDS.swapPercent,
    source: 'file',
  };
}

/** Lecture du fichier ; toute erreur (absent, droits) → défauts. */
export function readEarlyoomThresholds(path = EARLYOOM_DEFAULTS_FILE, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): EarlyoomThresholds {
  try {
    return parseEarlyoomThresholds(read(path));
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}

export { thresholdKB } from './forecast';
