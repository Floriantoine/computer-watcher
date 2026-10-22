// src/core/rules/config.ts — validation stricte des règles (la même côté main et côté service), modèles, transitions.
import { CATEGORIES, isCategory } from '../classify/categories';
import { APP_NAMES } from '../grouping/rules';
import { isNeverKillName } from './neverKill';
import { isPreapproved, RECOMMENDED_RULES, SYSTEM_DEFAULTS, withInactive4h, withRecommendedActive } from './recommended';
import { simulationCredit, type SimStats } from './simulation';
import type { Rule, RuleCondition, RuleIssue, RuleMatch, RuleMode, RulesConfig } from './types';

export const MAX_RULES = 20;
export const RULE_BOUNDS = {
  overMB: [100, 65_536], forMin: [1, 120], forHours: [1, 720], underMin: [1, 30],
  // anti-gel : jamais sous 70 % (tuerait des tests sur une machine simplement occupée), durées de 5 s à 10 min
  memPercent: [70, 99], memForSec: [5, 600], cpuPercent: [70, 100], cpuForSec: [10, 600],
  // pression mémoire (PSI full) : jamais sous 10 % (usage normal 0 à 8 %), durées de 5 s à 5 min
  psiPercent: [10, 90], psiForSec: [5, 300],
} as const;
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

const MIGRATED = { recommendedActive: true, recommendedInactive4h: true, recommendedSeeded: true } as const;
/**
 * Première installation (config.json absent) : interrupteur allumé, les 3 règles recommandées. Une config existante
 * d'avant les recommandées y arrive aussi, une fois, par la migration « recommandées ajoutées » (withSeeded).
 */
export const DEFAULT_RULES: RulesConfig = { enabled: true, list: RECOMMENDED_RULES.map((r) => structuredClone(r)), ...MIGRATED };
/** Section mal formée, fichier illisible ou invalide : tout éteint. */
export const RULES_OFF: RulesConfig = { enabled: false, list: [], ...MIGRATED };

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
    case 'system': {
      const B = RULE_BOUNDS;
      if (!intIn(raw.memPercent, B.memPercent)) return `seuil mémoire hors bornes (${B.memPercent[0]} à ${B.memPercent[1]} %)`;
      if (!intIn(raw.memForSec, B.memForSec)) return `durée mémoire hors bornes (${B.memForSec[0]} à ${B.memForSec[1]} s)`;
      if (!intIn(raw.cpuPercent, B.cpuPercent)) return `seuil CPU hors bornes (${B.cpuPercent[0]} à ${B.cpuPercent[1]} %)`;
      if (!intIn(raw.cpuForSec, B.cpuForSec)) return `durée CPU hors bornes (${B.cpuForSec[0]} à ${B.cpuForSec[1]} s)`;
      // pression : les deux champs ensemble, ou aucun (condition d'avant la pression, jamais déclenchée par elle)
      const psi = raw.psiPercent !== undefined || raw.psiForSec !== undefined;
      if (psi && !intIn(raw.psiPercent, B.psiPercent)) return `seuil de pression hors bornes (${B.psiPercent[0]} à ${B.psiPercent[1]} %)`;
      if (psi && !intIn(raw.psiForSec, B.psiForSec)) return `durée de pression hors bornes (${B.psiForSec[0]} à ${B.psiForSec[1]} s)`;
      // ordre des champs fixe : les conditions sont comparées par JSON (pré-approbation, révision, crédit de Simulation)
      return {
        kind: 'system', memPercent: raw.memPercent as number, memForSec: raw.memForSec as number,
        cpuPercent: raw.cpuPercent as number, cpuForSec: raw.cpuForSec as number,
        ...(psi ? { psiPercent: raw.psiPercent as number, psiForSec: raw.psiForSec as number } : {}),
      };
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
 * Migration unique (2026-10-21) : une config d'avant `recommendedSeeded` (mise à jour depuis la v0.3.0 ou avant, où les
 * recommandées n'étaient posées qu'à la création de config.json) reçoit les recommandées manquantes, à la fin. Aucune
 * règle à soi → interrupteur allumé, comme une première installation ; sinon l'interrupteur n'est pas touché.
 */
function withSeeded(enabled: boolean, list: Rule[]): { enabled: boolean; list: Rule[] } {
  const seeded = withRecommendedRules({ enabled, list }, 0).rules;
  return { enabled: list.length === 0 ? true : enabled, list: seeded.list };
}

/**
 * Validation stricte, règle par règle : une règle invalide (modifiée à la main) est ignorée seule et décrite dans
 * `issues` ; au-delà de MAX_RULES, les suivantes aussi ; un id déjà vu aussi. Section absente (config d'avant les
 * règles) → recommandées ajoutées, interrupteur allumé (withSeeded).
 * Une section mal formée (pas un objet, liste absente) → règles éteintes, une erreur ; jamais de réinitialisation du reste.
 */
export function validateRulesDetailed(raw: unknown): { rules: RulesConfig; issues: RuleIssue[] } {
  // config existante d'avant les règles : recommandées ajoutées une fois (withSeeded)
  if (raw === undefined) return { rules: { ...withSeeded(false, []), ...MIGRATED }, issues: [] };
  const broken = (error: string) => ({ rules: structuredClone(RULES_OFF), issues: [{ index: -1, id: null, name: null, error }] });
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
  // migration unique : règles recommandées intactes en Active (accord de l'utilisateur du 2026-10-20)
  const at4h = raw.recommendedInactive4h === true ? out : withInactive4h(out);
  const migrated = raw.recommendedActive === true ? at4h : withRecommendedActive(at4h);
  const final = raw.recommendedSeeded === true ? { enabled, list: migrated } : withSeeded(enabled, migrated);
  if (dropped) issues.push({ index: -1, id: null, name: null, error: `… et ${dropped} autre${dropped > 1 ? 's' : ''} règle${dropped > 1 ? 's' : ''} refusée${dropped > 1 ? 's' : ''}` });
  return { rules: { ...final, ...MIGRATED }, issues };
}

export function validateRules(raw: unknown): RulesConfig {
  return validateRulesDetailed(raw).rules;
}

const sameCondition = (a: RuleCondition, b: RuleCondition) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Erreur (texte FR) si une règle absente de `prev` arrive en mode 'active', si une règle active change de condition
 * sans repasser en Simulation, si une règle passe en Active sans crédit de Simulation enregistré par le service
 * (≥ 10 min et ≥ 1 évaluation, même condition), ou si un id est dupliqué ; null sinon. Seule exception : les règles
 * recommandées intactes (isPreapproved), approuvées telles quelles.
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
    if (isPreapproved(r)) continue;
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

/** Les 4 modèles fournis : tous désactivés, en Simulation (nouvel id : jamais pré-approuvés). */
export const RULE_TEMPLATES: readonly Omit<Rule, 'id' | 'createdAt'>[] = [
  {
    name: 'Test > 4 Go pendant 5 min', enabled: false, mode: 'simulate',
    condition: { kind: 'memory', target: 'instance', match: { by: 'category', value: 'test' }, overMB: 4096, forMin: 5 },
  },
  { name: 'Front/Back de projet inactif depuis 4 h', enabled: false, mode: 'simulate', condition: { kind: 'inactive', categories: ['front', 'back'], forHours: 4 } },
  { name: 'Épuisement prévu dans < 3 min', enabled: false, mode: 'simulate', condition: { kind: 'forecast', underMin: 3, includeApps: [] } },
  { name: 'Mémoire ou CPU > 95 % : tuer les tests', enabled: false, mode: 'simulate', condition: { kind: 'system', ...SYSTEM_DEFAULTS } },
];

/**
 * Bouton « Ajouter les règles recommandées » : ajoute celles dont l'id manque (jamais d'écrasement ni de doublon), à
 * la fin, datées de `now`, dans la limite de MAX_RULES. L'interrupteur général n'est pas touché. Idempotent.
 */
export function withRecommendedRules(rules: RulesConfig, now: number): { rules: RulesConfig; added: Rule[] } {
  const ids = new Set(rules.list.map((r) => r.id));
  const room = Math.max(0, MAX_RULES - rules.list.length);
  const createdAt = Math.max(0, Math.floor(now));
  const added = RECOMMENDED_RULES.filter((r) => !ids.has(r.id)).slice(0, room).map((r) => ({ ...structuredClone(r), createdAt }));
  return { rules: { ...rules, list: [...rules.list, ...added] }, added };
}

/** Règles recommandées absentes (par id). */
export const missingRecommended = (rules: RulesConfig): Rule[] => RECOMMENDED_RULES.filter((r) => !rules.list.some((x) => x.id === r.id));
