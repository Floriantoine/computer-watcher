// src/main/historyIpc.ts — parties pures de l'IPC historique (validation, état du service)
import { isCategory } from '../core/classify/categories';
import { MAX_OVERRIDE_KEY, MAX_OVERRIDES, validateConfigDetailed } from '../core/config';
import { checkRulesTransition } from '../core/rules/config';
import type { Category, Config, RangePreset, RecorderState, RecorderStatus, TimeRange, TopOptions } from '../core/types';

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

export const MAX_INSTANCE_KEYS = 200;
/** Une clé d'instance contient l'id du groupe, donc un chemin de projet (PATH_MAX 4096) + `#pid:startTicks`. */
export const MAX_INSTANCE_KEY_LEN = 4096;

/** Clés d'instances (ou de groupes) demandées : 1 à 200 chaînes non vides et bornées. */
export const isInstanceKeys = (k: unknown): k is string[] =>
  Array.isArray(k) && k.length >= 1 && k.length <= MAX_INSTANCE_KEYS &&
  k.every((x) => typeof x === 'string' && x.length >= 1 && x.length <= MAX_INSTANCE_KEY_LEN);

/** Début de la période « inactive depuis » : fini, ≥ 0, pas dans le futur (sinon tout serait « inactif »). */
export const isSinceMs = (v: unknown, now: number = Date.now()): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= now;

/** Rejeu de l'arbre : groupKey chaîne de 1 à 4 096 caractères ; ts nombre fini, ≥ 0, ≤ now + 60 s. */
export function isProcTreeRequest(groupKey: unknown, ts: unknown, now: number = Date.now()): boolean {
  return (
    typeof groupKey === 'string' && groupKey.length >= 1 && groupKey.length <= MAX_INSTANCE_KEY_LEN &&
    typeof ts === 'number' && Number.isFinite(ts) && ts >= 0 && ts <= now + 60_000
  );
}

/** Filtre optionnel des événements par groupe : absent, ou clé de 1 à 4 096 caractères. */
export const isOptionalGroupKey = (k: unknown): k is string | undefined =>
  k === undefined || (typeof k === 'string' && k.length >= 1 && k.length <= MAX_INSTANCE_KEY_LEN);

const isBoundedText = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= MAX_OVERRIDE_KEY;

/**
 * Arguments de `classify:set` → clé de correction `${scope}|${signature}` et catégorie (null : retour à l'automatique).
 * Chaînes de 1 à 300 caractères, clé complète ≤ 300 (sinon la config sauvegardée serait invalide), catégorie connue ou null.
 */
export function classifySetKey(scope: unknown, signature: unknown, category: unknown): { key: string; category: Category | null } | null {
  if (!isBoundedText(scope) || !isBoundedText(signature)) return null;
  if (category !== null && !isCategory(category)) return null;
  const key = `${scope}|${signature}`;
  return key.length <= MAX_OVERRIDE_KEY ? { key, category } : null;
}

/** Nouvelles corrections (copie) ; null si l'ajout dépasserait 500 corrections. */
export function applyOverride(overrides: Record<string, Category>, key: string, category: Category | null): Record<string, Category> | null {
  const next: Record<string, Category> = { ...overrides };
  if (category === null) {
    delete next[key];
    return next;
  }
  if (!Object.prototype.hasOwnProperty.call(next, key) && Object.keys(next).length >= MAX_OVERRIDES) return null;
  next[key] = category;
  return next;
}

/**
 * `config:set` : validation stricte (une règle refusée refuse tout l'enregistrement, contrairement à la lecture du
 * fichier), puis transition des règles (une nouvelle règle, ou une règle active modifiée, démarre en Simulation).
 * Lève une erreur au texte affichable tel quel ; rien n'est sauvegardé.
 */
export function checkConfigSet(next: unknown, current: Config): Config {
  const checked = validateConfigDetailed(next);
  if (!checked) throw new Error('Configuration invalide');
  const issue = checked.ruleIssues[0];
  if (issue) throw new Error(`Règle ${issue.name ? `« ${issue.name} »` : `n° ${issue.index + 1}`} invalide : ${issue.error}`);
  const err = checkRulesTransition(current.rules, checked.config.rules);
  if (err) throw new Error(err);
  return checked.config;
}

/** Handler `kill` de l'app : PROC_WATCH_NO_KILL=1 (vérifications visuelles) → aucun signal, chaque cible refusée NOKILL. */
export const noKill = (env: NodeJS.ProcessEnv = process.env): boolean => env.PROC_WATCH_NO_KILL === '1';
