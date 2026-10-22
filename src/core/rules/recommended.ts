// src/core/rules/recommended.ts — règles recommandées (ids stables `rec-…`, pour détecter leur présence) et
// leur pré-approbation. Pur, sans dépendance (partagé par le main, le service et le renderer).
import type { Rule, RuleCondition } from './types';

export const REC_INACTIVE_ID = 'rec-inactive-front-back';
export const REC_TEST_MEMORY_ID = 'rec-test-memory';
export const REC_ANTIGEL_ID = 'rec-antigel';

/**
 * Valeurs par défaut de la condition système (formulaire, modèle et règle recommandée), dans l'ordre de la validation.
 * Pression mémoire du bureau et des applis (PSI full) 40 % pendant 20 s : proche de 0 en usage normal ; pendant le gel du
 * 2026-10-22, la PSI de la machine est restée à 60-90 % alors que la mémoire utilisée n'a jamais passé 93 %.
 */
export const SYSTEM_DEFAULTS = { memPercent: 95, memForSec: 15, cpuPercent: 95, cpuForSec: 60, psiPercent: 40, psiForSec: 20 } as const;

const ANTIGEL_CONDITION: RuleCondition = { kind: 'system', ...SYSTEM_DEFAULTS };

/**
 * Les 3 règles recommandées, activées et en Active (approuvées telles quelles par l'utilisateur, 2026-10-20 : voir
 * isPreapproved). `createdAt` : remplacé par l'instant d'ajout par le bouton « Ajouter les règles recommandées ».
 */
export const RECOMMENDED_RULES: readonly Rule[] = [
  {
    id: REC_INACTIVE_ID, name: 'Front/Back de projet inactif depuis 4 h', enabled: true, mode: 'active', createdAt: 0,
    condition: { kind: 'inactive', categories: ['front', 'back'], forHours: 4 },
  },
  {
    id: REC_TEST_MEMORY_ID, name: 'Test > 4 Go pendant 5 min', enabled: true, mode: 'active', createdAt: 0,
    condition: { kind: 'memory', target: 'instance', match: { by: 'category', value: 'test' }, overMB: 4096, forMin: 5 },
  },
  {
    id: REC_ANTIGEL_ID, name: 'Machine saturée : tuer les tests', enabled: true, mode: 'active', createdAt: 0,
    condition: ANTIGEL_CONDITION,
  },
];

/**
 * Règle recommandée intacte (même id ET même condition, champ par champ) : elle peut être Active sans crédit de
 * Simulation (approuvée telle quelle). Toute modification de sa condition lui retire cette exception.
 */
export function isPreapproved(rule: Pick<Rule, 'id' | 'condition'>): boolean {
  const rec = RECOMMENDED_RULES.find((r) => r.id === rule.id);
  return !!rec && JSON.stringify(rule.condition) === JSON.stringify(rec.condition);
}

/**
 * Migration unique (2026-10-20) d'une config d'avant `recommendedActive` : les règles recommandées intactes encore en
 * Simulation passent en Active. Une fois faite (marqueur posé par la validation), un retour en Simulation est respecté.
 */
export function withRecommendedActive(list: readonly Rule[]): Rule[] {
  return list.map((r) => (r.mode === 'simulate' && isPreapproved(r) ? { ...r, mode: 'active' } : r));
}

/** Ancienne version (jusqu'au 2026-10-21) de la règle « inactif » recommandée : 1 j au lieu de 4 h. */
const OLD_INACTIVE_CONDITION: RuleCondition = { kind: 'inactive', categories: ['front', 'back'], forHours: 24 };

/**
 * Migration unique (2026-10-21, demandée par l'utilisateur) : la règle « inactif depuis 1 j » recommandée intacte passe
 * à 4 h, activée et en Active. Une fois faite (marqueur posé par la validation), un retour à 1 j est respecté.
 */
export function withInactive4h(list: readonly Rule[]): Rule[] {
  const rec = RECOMMENDED_RULES.find((r) => r.id === REC_INACTIVE_ID)!;
  return list.map((r) =>
    r.id === REC_INACTIVE_ID && JSON.stringify(r.condition) === JSON.stringify(OLD_INACTIVE_CONDITION)
      ? { ...r, name: rec.name, enabled: true, mode: 'active', condition: structuredClone(rec.condition) }
      : r,
  );
}

/** Ancienne version (jusqu'au 2026-10-22) de la règle anti-gel recommandée : mémoire ou CPU, sans la pression. */
const OLD_ANTIGEL_CONDITION: RuleCondition = { kind: 'system', memPercent: 95, memForSec: 15, cpuPercent: 95, cpuForSec: 60 };
const OLD_ANTIGEL_NAME = 'Mémoire ou CPU > 95 % : tuer les tests';

/**
 * Migration unique (2026-10-22, après un gel où la mémoire utilisée n'a jamais atteint 95 %) : la règle anti-gel
 * recommandée intacte (ancienne condition exacte) reçoit la condition de pression mémoire, et le nouveau nom si elle
 * portait l'ancien ; activation et mode restent ceux de l'utilisateur. Une fois faite (marqueur posé par la validation),
 * un retour à l'ancienne condition est respecté.
 */
export function withAntigelPsi(list: readonly Rule[]): Rule[] {
  const rec = RECOMMENDED_RULES.find((r) => r.id === REC_ANTIGEL_ID)!;
  return list.map((r) =>
    r.id === REC_ANTIGEL_ID && JSON.stringify(r.condition) === JSON.stringify(OLD_ANTIGEL_CONDITION)
      ? { ...r, name: r.name === OLD_ANTIGEL_NAME ? rec.name : r.name, condition: structuredClone(rec.condition) }
      : r,
  );
}
