// src/core/rules/config.ts — validation stricte des règles (la même côté main et côté service), modèles, transitions.
import { CATEGORIES, isCategory } from '../classify/categories';
import { APP_NAMES } from '../grouping/rules';
import { isNeverKillName } from './neverKill';
import { simulationCredit, type SimStats } from './simulation';
import type { Rule, RuleCondition, RuleIssue, RuleMatch, RuleMode, RulesConfig } from './types';

export const MAX_RULES = 20;
export const RULE_BOUNDS = { overMB: [100, 65_536], forMin: [1, 120], forHours: [1, 720], underMin: [1, 30] } as const;
export const RULE_ID_RE = /^[a-z0-9-]{1,40}$/;
export const RULE_NAME_MAX = 80;
/**
 * Nom de processus ou d'instance à comparer : jeu de caractères sûr (lettres, chiffres, espace et `._+:@/()-`),
 * 1 à 100 caractères. Comparé tel quel (sans casse), jamais interprété comme regex.
 */
export const MATCH_VALUE_RE = /^[A-Za-z0-9._+:@/()-][A-Za-z0-9 ._+:@/()-]{0,99}$/;
/** Applis qu'une règle de prévision peut viser sur choix explicite (jamais Claude, Warp, ni Electron qui fait tourner l'app). */
export const OPT_IN_APPS: readonly string[] = [...APP_NAMES].filter((n) => !isNeverKillName(n) && n !== 'electron').sort();

/** Erreurs de règles gardées (au-delà : une ligne « … et n autres »). */
export const MAX_RULE_ISSUES = 20;

export const DEFAULT_RULES: RulesConfig = { enabled: false, list: [] };

const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const intIn = (v: unknown, [lo, hi]: readonly [number, number]) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

/** Message d'erreur (français) ou la condition reconstruite champ par champ (les champs inconnus ne sont pas recopiés). */
function validateCondition(raw: unknown): RuleCondition | string {
  if (!isObj(raw)) return 'condition absente';
  switch (raw.kind) {
    case 'memory': {
      if (raw.target !== 'group' && raw.target !== 'instance') return 'cible inconnue (groupe ou instance)';
      const m = raw.match;
      if (!isObj(m)) return 'correspondance absente';
      let match: RuleMatch;
      if (m.by === 'name') {
        if (typeof m.value !== 'string' || !MATCH_VALUE_RE.test(m.value) || !m.value.trim()) return 'nom à comparer invalide (1 à 100 caractères : lettres, chiffres, espace, . _ + : @ / ( ) -)';
        match = { by: 'name', value: m.value };
      } else if (m.by === 'category') {
        if (!isCategory(m.value)) return 'catégorie inconnue';
        match = { by: 'category', value: m.value };
      } else return 'correspondance inconnue (nom ou catégorie)';
      if (!intIn(raw.overMB, RULE_BOUNDS.overMB)) return `seuil hors bornes (${RULE_BOUNDS.overMB[0]} à ${RULE_BOUNDS.overMB[1]} Mo)`;
      if (!intIn(raw.forMin, RULE_BOUNDS.forMin)) return `durée hors bornes (${RULE_BOUNDS.forMin[0]} à ${RULE_BOUNDS.forMin[1]} min)`;
      return { kind: 'memory', target: raw.target, match, overMB: raw.overMB as number, forMin: raw.forMin as number };
    }
    case 'inactive': {
      const cats = raw.categories;
      if (!Array.isArray(cats) || cats.length < 1 || cats.length > CATEGORIES.length || !cats.every(isCategory)) return 'catégorie inconnue';
      if (!intIn(raw.forHours, RULE_BOUNDS.forHours)) return `durée hors bornes (${RULE_BOUNDS.forHours[0]} à ${RULE_BOUNDS.forHours[1]} h)`;
      return { kind: 'inactive', categories: CATEGORIES.filter((c) => cats.includes(c)), forHours: raw.forHours as number };
    }
    case 'forecast': {
      if (!intIn(raw.underMin, RULE_BOUNDS.underMin)) return `délai hors bornes (${RULE_BOUNDS.underMin[0]} à ${RULE_BOUNDS.underMin[1]} min)`;
      const apps = raw.includeApps ?? [];
      if (!Array.isArray(apps) || apps.length > OPT_IN_APPS.length || !apps.every((a) => typeof a === 'string' && OPT_IN_APPS.includes(a))) {
        return 'applis incluses inconnues';
      }
      return { kind: 'forecast', underMin: raw.underMin as number, includeApps: [...new Set(apps as string[])].sort() };
    }
    default:
      return 'type de condition inconnu';
  }
}

function validateRule(raw: unknown): Rule | string {
  if (!isObj(raw)) return 'règle invalide';
  if (typeof raw.id !== 'string' || !RULE_ID_RE.test(raw.id)) return 'identifiant invalide';
  if (typeof raw.name !== 'string' || raw.name.trim().length < 1 || raw.name.length > RULE_NAME_MAX || CONTROL.test(raw.name)) return `nom invalide (1 à ${RULE_NAME_MAX} caractères)`;
  if (typeof raw.enabled !== 'boolean') return 'champ « activée » invalide';
  if (raw.mode !== 'simulate' && raw.mode !== 'active') return 'mode inconnu (simulate ou active)';
  if (!Number.isSafeInteger(raw.createdAt) || (raw.createdAt as number) < 0) return 'date de création invalide';
  const condition = validateCondition(raw.condition);
  if (typeof condition === 'string') return condition;
  return { id: raw.id, name: raw.name, enabled: raw.enabled, mode: raw.mode as RuleMode, condition, createdAt: raw.createdAt as number };
}

/**
 * Validation stricte, règle par règle : une règle invalide (modifiée à la main) est ignorée seule et décrite dans
 * `issues` ; au-delà de MAX_RULES, les suivantes aussi ; un id déjà vu aussi. Section absente → défauts (désactivé).
 * Une section mal formée (pas un objet, liste absente) → règles éteintes, une erreur ; jamais de réinitialisation du reste.
 */
export function validateRulesDetailed(raw: unknown): { rules: RulesConfig; issues: RuleIssue[] } {
  if (raw === undefined) return { rules: structuredClone(DEFAULT_RULES), issues: [] };
  const broken = (error: string) => ({ rules: structuredClone(DEFAULT_RULES), issues: [{ index: -1, id: null, name: null, error }] });
  if (!isObj(raw)) return broken('section « rules » invalide : règles éteintes');
  const enabled = raw.enabled ?? false;
  if (typeof enabled !== 'boolean') return broken('interrupteur « Règles automatiques » invalide : règles éteintes');
  const list = raw.list ?? [];
  if (!Array.isArray(list)) return broken('liste des règles invalide : règles éteintes');
  const out: Rule[] = [];
  const issues: RuleIssue[] = [];
  const ids = new Set<string>();
  let dropped = 0;
  list.forEach((item, index) => {
    const id = isObj(item) && typeof item.id === 'string' ? item.id.slice(0, 40) : null;
    const name = isObj(item) && typeof item.name === 'string' ? item.name.slice(0, RULE_NAME_MAX) : null;
    const r = validateRule(item);
    let error = typeof r === 'string' ? r : null;
    if (!error && ids.has((r as Rule).id)) error = 'identifiant en double';
    if (!error && out.length >= MAX_RULES) error = `au plus ${MAX_RULES} règles`;
    if (error) {
      if (issues.length < MAX_RULE_ISSUES) issues.push({ index, id, name, error });
      else dropped++;
      return;
    }
    ids.add((r as Rule).id);
    out.push(r as Rule);
  });
  if (dropped) issues.push({ index: -1, id: null, name: null, error: `… et ${dropped} autre${dropped > 1 ? 's' : ''} règle${dropped > 1 ? 's' : ''} refusée${dropped > 1 ? 's' : ''}` });
  return { rules: { enabled, list: out }, issues };
}

export function validateRules(raw: unknown): RulesConfig {
  return validateRulesDetailed(raw).rules;
}

const sameCondition = (a: RuleCondition, b: RuleCondition) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Erreur (texte FR) si une règle absente de `prev` arrive en mode 'active', si une règle active change de condition
 * sans repasser en Simulation, si une règle passe en Active sans crédit de Simulation enregistré par le service
 * (≥ 10 min et ≥ 1 évaluation, même condition), ou si un id est dupliqué ; null sinon.
 */
export function checkRulesTransition(prev: RulesConfig, next: RulesConfig, sim: SimStats | null = null): string | null {
  const ids = new Set<string>();
  for (const r of next.list) {
    if (ids.has(r.id)) return `Identifiant de règle en double : ${r.id}`;
    ids.add(r.id);
  }
  const before = new Map(prev.list.map((r) => [r.id, r]));
  for (const r of next.list) {
    if (r.mode !== 'active') continue;
    const old = before.get(r.id);
    if (!old) return `Une nouvelle règle démarre en Simulation (« ${r.name} »)`;
    if (!sameCondition(old.condition, r.condition)) return `Une règle modifiée repasse en Simulation (« ${r.name} »)`;
    if (old.mode !== 'active') {
      const c = simulationCredit(sim, r);
      if (!c.ok) {
        return c.evaluations === 0
          ? `Au moins 10 min en Simulation avant de passer en Active (« ${r.name} » : aucune évaluation par le service ; active l'interrupteur et la règle)`
          : `Au moins 10 min en Simulation avant de passer en Active (« ${r.name} » : encore ${c.minutesLeft} min)`;
      }
    }
  }
  return null;
}

/** Les 3 modèles fournis : tous désactivés, en Simulation. */
export const RULE_TEMPLATES: readonly Omit<Rule, 'id' | 'createdAt'>[] = [
  {
    name: 'vitest > 4 Go pendant 5 min', enabled: false, mode: 'simulate',
    condition: { kind: 'memory', target: 'instance', match: { by: 'name', value: 'vitest' }, overMB: 4096, forMin: 5 },
  },
  { name: 'Front/Back de projet inactif depuis 1 j', enabled: false, mode: 'simulate', condition: { kind: 'inactive', categories: ['front', 'back'], forHours: 24 } },
  { name: 'Épuisement prévu dans < 3 min', enabled: false, mode: 'simulate', condition: { kind: 'forecast', underMin: 3, includeApps: [] } },
];
