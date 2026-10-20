// Anti-gel (lot 1) : réglages. Sans import Node : utilisé aussi par le renderer (Réglages, budget d'un projet).
import { normalizePath } from '../disk/projects';

export interface AntigelConfig {
  /** Interrupteur, allumé par défaut. Éteint : aucun déplacement, plafonds remis à « infinity ». */
  enabled: boolean;
  /** Réserve pour le bureau, en Mo ; null : automatique, max(4 Go, 15 % de la RAM). */
  reserveMB: number | null;
  /** Budget mémoire (MemoryHigh du scope du projet) par racine de projet, en Mo ; aucun par défaut. */
  budgets: Record<string, number>;
}

export const RESERVE_MIN_MB = 1024;
export const RESERVE_MAX_MB = 1_048_576;
export const BUDGET_MIN_MB = 256;
export const BUDGET_MAX_MB = 1_048_576;
export const MAX_BUDGETS = 100;
const MAX_PATH = 1024;

const isMB = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** Racine de projet d'un budget : chemin absolu normalisé, jamais « / ». null : refusée. */
export function budgetKey(path: string): string | null {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > MAX_PATH || path.includes('\0')) return null;
  const n = normalizePath(path);
  return n === '/' ? null : n;
}

/** Section `antigel` de config.json. Absente : défauts (allumé). null : refusée (la config entière l'est alors). */
export function validateAntigel(raw: unknown): AntigelConfig | null {
  if (raw === undefined) return { enabled: true, reserveMB: null, budgets: {} };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled !== 'boolean') return null;
  const reserve = r.reserveMB === undefined ? null : r.reserveMB;
  if (reserve !== null && !isMB(reserve, RESERVE_MIN_MB, RESERVE_MAX_MB)) return null;
  const b = r.budgets === undefined ? {} : r.budgets;
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return null;
  const entries = Object.entries(b as Record<string, unknown>);
  if (entries.length > MAX_BUDGETS) return null;
  const budgets: Record<string, number> = {};
  for (const [k, v] of entries) {
    const key = budgetKey(k);
    if (key === null || !isMB(v, BUDGET_MIN_MB, BUDGET_MAX_MB)) return null;
    budgets[key] = v;
  }
  return { enabled: r.enabled, reserveMB: reserve as number | null, budgets };
}
