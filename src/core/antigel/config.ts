// Anti-gel (lot 1) : réglages. Sans import Node : utilisé aussi par le renderer (Réglages, budget d'un projet).
import { normalizePath } from '../disk/projects';

export interface AntigelConfig {
  /** Interrupteur, allumé par défaut. Éteint : aucun déplacement, plafonds remis à « infinity ». */
  enabled: boolean;
  /** Réserve pour le bureau, en Mo ; null : automatique, max(4 Go, 15 % de la RAM). */
  reserveMB: number | null;
  /** Budget mémoire (MemoryHigh de la slice du projet) par racine de projet, en Mo ; aucun par défaut. */
  budgets: Record<string, number>;
  /** Bureau prioritaire (lot 2) : poids CPU du bureau, protection mémoire si elle peut agir ; absent : allumé. */
  desk?: boolean;
  /**
   * Budget par défaut (Mo) de chaque projet capturé sans budget explicite ; null : aucun. Migration dans validateAntigel :
   * absent du fichier (config d'avant ce réglage) → DEFAULT_BUDGET_MB, toujours renseigné en sortie, donc écrit au prochain
   * enregistrement. Absent d'un objet construit en mémoire sans passer par la validation : aucun (effectiveBudget).
   */
  defaultBudgetMB?: number | null;
  /** Racines de projet explicitement sans budget (le budget par défaut ne s'y applique pas) ; un budget explicite l'emporte. */
  noBudget?: string[];
}

export const RESERVE_MIN_MB = 1024;
export const RESERVE_MAX_MB = 1_048_576;
export const BUDGET_MIN_MB = 256;
export const BUDGET_MAX_MB = 1_048_576;
export const MAX_BUDGETS = 100;
/** Budget par défaut d'un projet : 5 Go (nouvelle installation, et config existante sans le champ). */
export const DEFAULT_BUDGET_MB = 5120;
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
  if (raw === undefined) return { enabled: true, reserveMB: null, budgets: {}, defaultBudgetMB: DEFAULT_BUDGET_MB };
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
  if (r.desk !== undefined && typeof r.desk !== 'boolean') return null;
  const def = r.defaultBudgetMB === undefined ? DEFAULT_BUDGET_MB : r.defaultBudgetMB;
  if (def !== null && !isMB(def, BUDGET_MIN_MB, BUDGET_MAX_MB)) return null;
  let noBudget: string[] | undefined;
  if (r.noBudget !== undefined) {
    if (!Array.isArray(r.noBudget) || r.noBudget.length > MAX_BUDGETS) return null;
    const keys = new Set<string>();
    for (const k of r.noBudget) {
      const key = typeof k === 'string' ? budgetKey(k) : null;
      if (key === null) return null;
      keys.add(key);
    }
    noBudget = [...keys];
  }
  return {
    enabled: r.enabled, reserveMB: reserve as number | null, budgets, defaultBudgetMB: def as number | null,
    ...(r.desk === undefined ? {} : { desk: r.desk }), ...(noBudget === undefined ? {} : { noBudget }),
  };
}

/**
 * Budget effectif d'un projet : le budget explicite l'emporte, puis « sans budget » (noBudget), puis le budget par
 * défaut. Hors projet (null, slice « autres ») : aucun.
 */
export function effectiveBudget(c: AntigelConfig, root: string | null): { mb: number; source: 'explicit' | 'default' } | null {
  if (root === null || !root.startsWith('/')) return null;
  if (Object.hasOwn(c.budgets, root)) return { mb: c.budgets[root]!, source: 'explicit' };
  if (c.noBudget?.includes(root)) return null;
  const def = c.defaultBudgetMB ?? null;
  return def === null ? null : { mb: def, source: 'default' };
}
