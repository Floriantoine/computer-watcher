import { describe, expect, test } from 'vitest';
import { RULE_TEMPLATES } from './config';
import { accumulateSimulation, parseSimStats, simulationCredit, type SimStats } from './simulation';
import type { Rule } from './types';

const MIN = 60_000;
const r = (over: Partial<Rule> = {}): Rule => ({ ...RULE_TEMPLATES[0]!, id: 'r-a', createdAt: 0, enabled: true, ...over });

describe('m-3 : crédit de Simulation', () => {
  test('ne compte que règle activée, interrupteur allumé, mode simulate ; une évaluation par appel', () => {
    let st: SimStats = {};
    st = accumulateSimulation(st, [r()], true, 30_000);
    st = accumulateSimulation(st, [r()], true, 30_000);
    expect(st['r-a']).toMatchObject({ simulatedMs: 60_000, evaluations: 2 });
    st = accumulateSimulation(st, [r({ enabled: false })], true, 10 * MIN);
    st = accumulateSimulation(st, [r()], false, 10 * MIN);
    st = accumulateSimulation(st, [r({ mode: 'active' })], true, 10 * MIN);
    expect(st['r-a']).toMatchObject({ simulatedMs: 60_000, evaluations: 2 });
  });
  test('condition changée → le crédit repart ; règle supprimée → oubliée ; durée négative ignorée', () => {
    let st: SimStats = accumulateSimulation({}, [r()], true, 5 * MIN);
    st = accumulateSimulation(st, [r({ condition: { ...(r().condition as object), overMB: 200 } as Rule['condition'] })], true, 30_000);
    expect(st['r-a']).toMatchObject({ simulatedMs: 30_000, evaluations: 1 });
    st = accumulateSimulation(st, [r()], true, -5 * MIN);
    expect(st['r-a']!.simulatedMs).toBe(0);
    expect(accumulateSimulation(st, [], true, 1000)).toEqual({});
  });
  test('Active exige ≥ 10 min ET ≥ 1 évaluation, avec la même condition', () => {
    const ok = accumulateSimulation({}, [r()], true, 10 * MIN);
    expect(simulationCredit(ok, r()).ok).toBe(true);
    expect(simulationCredit(accumulateSimulation({}, [r()], true, 9 * MIN), r())).toMatchObject({ ok: false, minutesLeft: 1 });
    expect(simulationCredit({ 'r-a': { ...ok['r-a']!, evaluations: 0 } }, r()).ok).toBe(false);
    expect(simulationCredit(ok, r({ condition: { ...(r().condition as object), forMin: 9 } as Rule['condition'] })).ok).toBe(false);
    expect(simulationCredit(null, r()).ok).toBe(false);
    expect(simulationCredit({}, { ...r(), simulatedSince: 0 } as unknown as Rule).ok).toBe(false); // simulatedSince écrit à la main : aucun crédit
  });
  test('parseSimStats : fichier invalide ou entrées mal formées ignorés', () => {
    expect(parseSimStats('pas du json')).toEqual({});
    expect(parseSimStats(JSON.stringify({ a: { condition: 'x', simulatedMs: 5, evaluations: 1 }, b: { condition: 1 }, c: { condition: 'y', simulatedMs: -1, evaluations: 1 } })))
      .toEqual({ a: { condition: 'x', simulatedMs: 5, evaluations: 1 } });
  });
});
