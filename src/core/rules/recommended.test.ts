import { describe, expect, test } from 'vitest';
import { checkRulesTransition, DEFAULT_RULES, MAX_RULES, missingRecommended, validateRulesDetailed, withRecommendedRules } from './config';
import { isPreapproved, REC_ANTIGEL_ID, REC_INACTIVE_ID, REC_TEST_MEMORY_ID, RECOMMENDED_RULES } from './recommended';
import { simulationCredit } from './simulation';
import type { Rule, RulesConfig } from './types';

const byId = (id: string) => RECOMMENDED_RULES.find((r) => r.id === id)!;
const mine: Rule = {
  id: 'r-a', name: 'à moi', enabled: false, mode: 'simulate', createdAt: 5,
  condition: { kind: 'memory', target: 'instance', match: { by: 'name', value: 'vitest' }, overMB: 4096, forMin: 5 },
};

describe('règles recommandées', () => {
  test('défauts : interrupteur allumé, 3 règles valides aux ids stables, modes attendus', () => {
    expect(DEFAULT_RULES.enabled).toBe(true);
    const r = validateRulesDetailed(DEFAULT_RULES);
    expect(r.issues).toEqual([]);
    expect(r.rules).toEqual(DEFAULT_RULES);
    expect(byId(REC_INACTIVE_ID)).toMatchObject({ enabled: true, mode: 'simulate', condition: { kind: 'inactive', categories: ['front', 'back'], forHours: 24 } });
    expect(byId(REC_TEST_MEMORY_ID)).toMatchObject({
      enabled: true, mode: 'simulate',
      condition: { kind: 'memory', target: 'instance', match: { by: 'category', value: 'test' }, overMB: 4096, forMin: 5 },
    });
    expect(byId(REC_ANTIGEL_ID)).toMatchObject({
      enabled: true, mode: 'active', condition: { kind: 'system', memPercent: 95, memForSec: 15, cpuPercent: 95, cpuForSec: 60 },
    });
  });

  test('DEFAULT_RULES ne partage aucun objet avec RECOMMENDED_RULES', () => {
    expect(DEFAULT_RULES.list[0]).not.toBe(RECOMMENDED_RULES[0]);
    expect(DEFAULT_RULES.list[2]!.condition).not.toBe(RECOMMENDED_RULES[2]!.condition);
  });

  test('pré-approbation : seulement l’anti-gel intact (même id ET même condition)', () => {
    const antigel = byId(REC_ANTIGEL_ID);
    expect(isPreapproved(antigel)).toBe(true);
    expect(isPreapproved({ ...antigel, id: 'r-x' })).toBe(false);
    expect(isPreapproved({ ...antigel, condition: { ...antigel.condition, memPercent: 90 } as Rule['condition'] })).toBe(false);
    expect(isPreapproved({ ...byId(REC_TEST_MEMORY_ID), id: REC_ANTIGEL_ID })).toBe(false);
    expect(isPreapproved(byId(REC_TEST_MEMORY_ID))).toBe(false);
  });

  test('crédit de Simulation : l’anti-gel intact est accepté sans crédit, modifié il en redemande', () => {
    const antigel = byId(REC_ANTIGEL_ID);
    expect(simulationCredit(null, antigel).ok).toBe(true);
    expect(simulationCredit(null, { ...antigel, condition: { ...antigel.condition, cpuForSec: 30 } as Rule['condition'] }).ok).toBe(false);
    expect(simulationCredit(null, byId(REC_TEST_MEMORY_ID)).ok).toBe(false);
  });

  test('transition : l’anti-gel intact peut arriver Actif ; modifié ou sous un autre id, refusé', () => {
    const prev: RulesConfig = { enabled: true, list: [mine] };
    const antigel = byId(REC_ANTIGEL_ID);
    expect(checkRulesTransition(prev, { enabled: true, list: [mine, antigel] })).toBeNull();
    const changed = { ...antigel, condition: { ...antigel.condition, memPercent: 80 } as Rule['condition'] };
    expect(checkRulesTransition(prev, { enabled: true, list: [mine, changed] })).toMatch(/nouvelle règle démarre en Simulation/);
    expect(checkRulesTransition({ enabled: true, list: [antigel] }, { enabled: true, list: [changed] })).toMatch(/repasse en Simulation/);
    expect(checkRulesTransition(prev, { enabled: true, list: [mine, { ...antigel, id: 'r-copie' }] })).toMatch(/nouvelle règle/);
    // les deux recommandées en Simulation ne peuvent pas arriver Actives
    expect(checkRulesTransition(prev, { enabled: true, list: [mine, { ...byId(REC_TEST_MEMORY_ID), mode: 'active' }] })).toMatch(/nouvelle règle/);
  });

  test('bouton « Ajouter les règles recommandées » : ajoute les manquantes, sans écraser ni dupliquer, idempotent', () => {
    // l'utilisateur a déjà une règle au même id que la règle de test, modifiée : jamais écrasée
    const custom: Rule = { ...byId(REC_TEST_MEMORY_ID), name: 'perso', mode: 'simulate', enabled: false, createdAt: 9 };
    const start: RulesConfig = { enabled: false, list: [mine, custom] };
    expect(missingRecommended(start).map((r) => r.id)).toEqual([REC_INACTIVE_ID, REC_ANTIGEL_ID]);
    const once = withRecommendedRules(start, 1_000);
    expect(once.added.map((r) => r.id)).toEqual([REC_INACTIVE_ID, REC_ANTIGEL_ID]);
    expect(once.rules.enabled).toBe(false); // interrupteur général non touché
    expect(once.rules.list.slice(0, 2)).toEqual([mine, custom]);
    expect(once.rules.list.slice(2).every((r) => r.createdAt === 1_000)).toBe(true);
    expect(validateRulesDetailed(once.rules).issues).toEqual([]);
    expect(checkRulesTransition(start, once.rules)).toBeNull();
    const twice = withRecommendedRules(once.rules, 2_000);
    expect(twice.added).toEqual([]);
    expect(twice.rules).toEqual(once.rules);
    expect(missingRecommended(twice.rules)).toEqual([]);
  });

  test('bouton : au plus MAX_RULES règles', () => {
    const list = Array.from({ length: MAX_RULES - 1 }, (_, i) => ({ ...mine, id: `r-${i}` }));
    const r = withRecommendedRules({ enabled: true, list }, 1);
    expect(r.added).toHaveLength(1);
    expect(r.rules.list).toHaveLength(MAX_RULES);
    expect(withRecommendedRules(r.rules, 2).added).toEqual([]);
  });
});
