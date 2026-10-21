import { describe, expect, test } from 'vitest';
import { checkRulesTransition, DEFAULT_RULES, MAX_RULES, missingRecommended, validateRulesDetailed, withRecommendedRules } from './config';
import { isPreapproved, REC_ANTIGEL_ID, REC_INACTIVE_ID, REC_TEST_MEMORY_ID, RECOMMENDED_RULES } from './recommended';
import type { RuleCondition } from './types';
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
    expect(byId(REC_INACTIVE_ID)).toMatchObject({ enabled: true, mode: 'active', condition: { kind: 'inactive', categories: ['front', 'back'], forHours: 4 } });
    expect(byId(REC_TEST_MEMORY_ID)).toMatchObject({
      enabled: true, mode: 'active',
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

  test('pré-approbation : les 3 recommandées intactes (même id ET même condition)', () => {
    for (const r of RECOMMENDED_RULES) expect(isPreapproved(r)).toBe(true);
    const antigel = byId(REC_ANTIGEL_ID);
    expect(isPreapproved({ ...antigel, id: 'r-x' })).toBe(false);
    expect(isPreapproved({ ...antigel, condition: { ...antigel.condition, memPercent: 90 } as RuleCondition })).toBe(false);
    expect(isPreapproved({ ...byId(REC_TEST_MEMORY_ID), id: REC_ANTIGEL_ID })).toBe(false);
    expect(isPreapproved({ ...byId(REC_TEST_MEMORY_ID), condition: { ...byId(REC_TEST_MEMORY_ID).condition, overMB: 2048 } as RuleCondition })).toBe(false);
    expect(isPreapproved({ ...byId(REC_INACTIVE_ID), condition: { kind: 'inactive', categories: ['front'], forHours: 4 } })).toBe(false);
  });

  test('crédit de Simulation : une recommandée intacte est acceptée sans crédit, modifiée elle en redemande', () => {
    for (const r of RECOMMENDED_RULES) expect(simulationCredit(null, r).ok).toBe(true);
    const antigel = byId(REC_ANTIGEL_ID);
    expect(simulationCredit(null, { ...antigel, condition: { ...antigel.condition, cpuForSec: 30 } as RuleCondition }).ok).toBe(false);
  });

  test('transition : une recommandée intacte peut arriver Active ; modifiée ou sous un autre id, refusée', () => {
    const prev: RulesConfig = { enabled: true, list: [mine] };
    const antigel = byId(REC_ANTIGEL_ID);
    expect(checkRulesTransition(prev, { enabled: true, list: [mine, antigel] })).toBeNull();
    expect(checkRulesTransition(prev, { enabled: true, list: [mine, ...RECOMMENDED_RULES] })).toBeNull();
    const changed = { ...antigel, condition: { ...antigel.condition, memPercent: 80 } as RuleCondition };
    expect(checkRulesTransition(prev, { enabled: true, list: [mine, changed] })).toMatch(/nouvelle règle démarre en Simulation/);
    expect(checkRulesTransition({ enabled: true, list: [antigel] }, { enabled: true, list: [changed] })).toMatch(/repasse en Simulation/);
    expect(checkRulesTransition(prev, { enabled: true, list: [mine, { ...antigel, id: 'r-copie' }] })).toMatch(/nouvelle règle/);
    // une recommandée en Simulation repasse en Active sans attendre
    const testSim = { ...byId(REC_TEST_MEMORY_ID), mode: 'simulate' as const };
    expect(checkRulesTransition({ enabled: true, list: [testSim] }, { enabled: true, list: [byId(REC_TEST_MEMORY_ID)] })).toBeNull();
  });

  test('migration unique : config sans marqueur → recommandées intactes en Active ; marqueur posé, puis Simulation respectée', () => {
    const sim = (r: Rule): Rule => ({ ...r, mode: 'simulate' });
    const changedTest = { ...sim(byId(REC_TEST_MEMORY_ID)), condition: { ...byId(REC_TEST_MEMORY_ID).condition, overMB: 2048 } as RuleCondition };
    const old = { enabled: true, list: [sim(byId(REC_INACTIVE_ID)), changedTest, sim(byId(REC_ANTIGEL_ID)), mine] };
    const out = validateRulesDetailed(old);
    expect(out.issues).toEqual([]);
    expect(out.rules.recommendedActive).toBe(true);
    expect(out.rules.list.map((r) => r.mode)).toEqual(['active', 'simulate', 'active', 'simulate']);
    // migration déjà faite : un retour en Simulation choisi par l'utilisateur est gardé
    const after = validateRulesDetailed({ ...old, recommendedActive: true });
    expect(after.rules.list.map((r) => r.mode)).toEqual(['simulate', 'simulate', 'simulate', 'simulate']);
    expect(validateRulesDetailed(out.rules).rules).toEqual(out.rules);
  });

  test('migration 4 h : l\'ancienne « inactif depuis 1 j » intacte passe à 4 h, activée et en Active ; une fois seulement', () => {
    const old1j: Rule = { ...byId(REC_INACTIVE_ID), name: 'Front/Back de projet inactif depuis 1 j', enabled: false, mode: 'simulate',
      condition: { kind: 'inactive', categories: ['front', 'back'], forHours: 24 } };
    const out = validateRulesDetailed({ enabled: true, list: [old1j, mine], recommendedActive: true });
    expect(out.issues).toEqual([]);
    expect(out.rules.recommendedInactive4h).toBe(true);
    expect(out.rules.list[0]).toEqual({ ...byId(REC_INACTIVE_ID), createdAt: old1j.createdAt });
    expect(out.rules.list[1]).toEqual(mine);
    // modifiée par l'utilisateur (12 h) : jamais touchée
    const custom = { ...old1j, condition: { kind: 'inactive', categories: ['front'], forHours: 12 } as RuleCondition };
    expect(validateRulesDetailed({ enabled: true, list: [custom], recommendedActive: true }).rules.list[0]).toEqual(custom);
    // migration déjà faite : un retour à 24 h choisi par l'utilisateur est gardé
    const kept = validateRulesDetailed({ enabled: true, list: [old1j], recommendedActive: true, recommendedInactive4h: true });
    expect(kept.rules.list[0]).toEqual(old1j);
    expect(byId(REC_INACTIVE_ID).condition).toEqual({ kind: 'inactive', categories: ['front', 'back'], forHours: 4 });
    expect(byId(REC_INACTIVE_ID).name).toBe('Front/Back de projet inactif depuis 4 h');
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
