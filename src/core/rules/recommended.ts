// src/core/rules/recommended.ts — règles recommandées (ids stables `rec-…`, pour détecter leur présence) et
// pré-approbation de la règle anti-gel. Pur, sans dépendance (partagé par le main, le service et le renderer).
import type { Rule, RuleCondition } from './types';

export const REC_INACTIVE_ID = 'rec-inactive-front-back';
export const REC_TEST_MEMORY_ID = 'rec-test-memory';
export const REC_ANTIGEL_ID = 'rec-antigel';

/** Valeurs par défaut de la condition système (formulaire, modèle et règle recommandée). */
export const SYSTEM_DEFAULTS = { memPercent: 95, memForSec: 15, cpuPercent: 95, cpuForSec: 60 } as const;

const ANTIGEL_CONDITION: RuleCondition = { kind: 'system', ...SYSTEM_DEFAULTS };

/**
 * Les 3 règles recommandées, activées : deux en Simulation, l'anti-gel en Active (approuvée telle quelle : voir
 * isPreapproved). `createdAt` : remplacé par l'instant d'ajout par le bouton « Ajouter les règles recommandées ».
 */
export const RECOMMENDED_RULES: readonly Rule[] = [
  {
    id: REC_INACTIVE_ID, name: 'Front/Back de projet inactif depuis 1 j', enabled: true, mode: 'simulate', createdAt: 0,
    condition: { kind: 'inactive', categories: ['front', 'back'], forHours: 24 },
  },
  {
    id: REC_TEST_MEMORY_ID, name: 'Test > 4 Go pendant 5 min', enabled: true, mode: 'simulate', createdAt: 0,
    condition: { kind: 'memory', target: 'instance', match: { by: 'category', value: 'test' }, overMB: 4096, forMin: 5 },
  },
  {
    id: REC_ANTIGEL_ID, name: 'Mémoire ou CPU > 95 % : tuer les tests', enabled: true, mode: 'active', createdAt: 0,
    condition: ANTIGEL_CONDITION,
  },
];

/**
 * Règle anti-gel recommandée, intacte (même id ET même condition, champ par champ) : elle peut être Active sans
 * crédit de Simulation (approuvée telle quelle). Toute modification de sa condition lui retire cette exception.
 */
export function isPreapproved(rule: Pick<Rule, 'id' | 'condition'>): boolean {
  return rule.id === REC_ANTIGEL_ID && JSON.stringify(rule.condition) === JSON.stringify(ANTIGEL_CONDITION);
}
