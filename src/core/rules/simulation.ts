// src/core/rules/simulation.ts — crédit de Simulation d'une règle (pur). Seul le service l'accumule : temps passé en
// Simulation avec la règle activée, l'interrupteur général allumé, et au moins une évaluation. Le passage en Active (main)
// et l'action réelle (service) exigent ≥ 10 min ET ≥ 1 évaluation, avec la même condition. Rien d'écrit à la main dans
// config.json ne donne de crédit.
import type { Rule, RuleCondition } from './types';

/** Simulation minimale avant le passage en Active (main et service). */
export const MIN_SIMULATION_MS = 10 * 60_000;

export interface SimRecord { condition: string; simulatedMs: number; evaluations: number }
export type SimStats = Record<string, SimRecord>;

export const conditionKey = (c: RuleCondition): string => JSON.stringify(c);

/** Une évaluation de plus : `deltaMs` (déjà plafonné par l'appelant) pour chaque règle en Simulation qui compte. */
export function accumulateSimulation(stats: SimStats, rules: readonly Rule[], enabled: boolean, deltaMs: number): SimStats {
  const out: SimStats = {};
  for (const r of rules) {
    const key = conditionKey(r.condition);
    const old = stats[r.id];
    const rec: SimRecord = old && old.condition === key ? { ...old } : { condition: key, simulatedMs: 0, evaluations: 0 };
    if (enabled && r.enabled && r.mode === 'simulate') {
      rec.simulatedMs += Math.max(0, deltaMs);
      rec.evaluations++;
    }
    out[r.id] = rec;
  }
  return out;
}

export function simulationCredit(stats: SimStats | null, rule: Rule): { ok: boolean; minutesLeft: number; evaluations: number } {
  const rec = stats?.[rule.id];
  if (!rec || rec.condition !== conditionKey(rule.condition)) return { ok: false, minutesLeft: Math.ceil(MIN_SIMULATION_MS / 60_000), evaluations: 0 };
  const ok = rec.simulatedMs >= MIN_SIMULATION_MS && rec.evaluations >= 1;
  return { ok, minutesLeft: Math.max(0, Math.ceil((MIN_SIMULATION_MS - rec.simulatedMs) / 60_000)), evaluations: rec.evaluations };
}

export function parseSimStats(text: string): SimStats {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return {};
  const out: SimStats = {};
  for (const [id, v] of Object.entries(o as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue;
    const r = v as Record<string, unknown>;
    if (typeof r.condition !== 'string' || !Number.isFinite(r.simulatedMs) || (r.simulatedMs as number) < 0 || !Number.isInteger(r.evaluations) || (r.evaluations as number) < 0) continue;
    out[id] = { condition: r.condition, simulatedMs: r.simulatedMs as number, evaluations: r.evaluations as number };
  }
  return out;
}
