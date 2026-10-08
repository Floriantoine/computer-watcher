// src/core/rules/engine.ts — moteur des règles automatiques (⑥). Pur : aucun effet de bord hors `state`, aucune
// horloge (instant fourni), aucun accès à /proc ni à la base (fonctions `inactive` et `isProtected` injectées).
import { MIN_DECLINING, type Forecast } from '../forecast/forecast';
import { flattenGroup, type Classification } from '../snapshot';
import type { Group, KillTarget, ProcInfo } from '../types';
import { filterTargets, type GuardContext } from './neverKill';
import type { Rule, RuleCondition, RuleMode } from './types';

export const RULE_COOLDOWN_MS = 300_000;
export const MAX_ACTIONS_PER_HOUR = 10;
export const INACTIVE_CHECK_MS = 60_000;
/** Quota horaire atteint : la règle est mise en pause pendant 1 h. */
export const QUOTA_PAUSE_MS = 3600_000;
const HOUR_MS = 3600_000;

export interface RuleTarget {
  /** Clé d'instance ou id de groupe. */
  key: string;
  kind: 'instance' | 'group';
  /** Groupe de la cible (clé du groupe dans l'historique). */
  groupKey: string;
  label: string;
  /** Mémoire (RAM + swap) des processus visés, après filtrage. */
  memKB: number;
  targets: KillTarget[];
  names: string[];
  /** RAM + swap de chaque processus visé (même ordre que `targets`). */
  memKBs: number[];
  /** Processus de la cible retirés par la liste « jamais tuer » / protégés / autre uid. */
  excluded: number;
}

export interface RuleState {
  /** `${ruleId}|${targetKey}` → début du dépassement */
  overSince: Map<string, number>;
  /** ruleId → dernier déclenchement (actif ou simulé) */
  lastFire: Map<string, number>;
  /** instants des actions réelles (fenêtre glissante 1 h) */
  actions: number[];
  /** idem pour la simulation (compteur séparé) */
  dryRuns: number[];
  /** ruleId → dernière évaluation d'une règle « inactive » */
  lastInactiveCheck: Map<string, number>;
  /** ruleId → fin de la pause après quota horaire atteint */
  pausedUntil: Map<string, number>;
  /** ruleId → dernier « rien à arrêter » signalé (au plus un par RULE_COOLDOWN_MS) */
  lastGuard: Map<string, number>;
}

export const emptyRuleState = (): RuleState => ({
  overSince: new Map(), lastFire: new Map(), actions: [], dryRuns: [], lastInactiveCheck: new Map(), pausedUntil: new Map(), lastGuard: new Map(),
});

export interface EvalInput {
  now: number;
  /** Interrupteur général « Règles automatiques » : éteint → aucune décision, aucun appel. */
  enabled: boolean;
  rules: readonly Rule[];
  groups: readonly Group[];
  classification: Classification | null;
  /** Prévision ② et décision de stepAlert : `held` = condition d'alerte tenue (≥ 30 s), sans l'anti-répétition. */
  forecast: { forecast: Forecast; held: boolean } | null;
  /** clé de groupe → hausse sur 5 min */
  growthKB: ReadonlyMap<string, number>;
  /** clés `${pid}:${startTicks}` ACTIVES depuis `sinceMs` ; null sans historique couvrant la période */
  inactive: ((targets: KillTarget[], sinceMs: number) => Set<string> | null) | null;
  isProtected: (name: string) => boolean;
  appRoot: string | null;
  currentUid: number;
  selfPid: number;
}

export type SkipReason = 'cooldown' | 'hourly-quota' | 'guard';
export type RuleDecision =
  | { ruleId: string; ruleName: string; mode: RuleMode; outcome: 'fire'; target: RuleTarget; condition: RuleCondition }
  | { ruleId: string; ruleName: string; mode: RuleMode; outcome: 'skip'; reason: SkipReason; target: RuleTarget | null };

/** Règle activée de type instance, catégorie ou inactive : le service doit classer les groupes. */
export function needsClassification(rules: readonly Rule[], enabled = true): boolean {
  if (!enabled) return false;
  return rules.some((r) => r.enabled && (r.condition.kind === 'inactive' ||
    (r.condition.kind === 'memory' && (r.condition.target === 'instance' || r.condition.match.by === 'category'))));
}

const mem = (p: { rssKB: number; swapKB: number }) => p.rssKB + p.swapKB;

/** Candidate avant filtrage : clé, groupe, libellé, pids, taille (pour choisir la plus grosse). */
interface Candidate { key: string; kind: 'instance' | 'group'; group: Group; label: string; pids: number[]; sizeKB: number }

export function evaluateRules(input: EvalInput, state: RuleState): RuleDecision[] {
  if (!input.enabled) return [];
  const { now } = input;
  const enabledRules = input.rules.filter((r) => r.enabled);
  // état des règles retirées ou désactivées
  const live = new Set(enabledRules.map((r) => r.id));
  for (const k of state.overSince.keys()) if (!live.has(k.slice(0, k.indexOf('|')))) state.overSince.delete(k);
  const cut = now - HOUR_MS;
  state.actions = state.actions.filter((t) => t > cut && t <= now);
  state.dryRuns = state.dryRuns.filter((t) => t > cut && t <= now);
  if (enabledRules.length === 0) return [];

  // Groupes visables : jamais « Autres » ni Claude ; processus connus (pour les ancêtres et les descendants).
  const groups = input.groups.filter((g) => g.kind !== 'others' && g.kind !== 'claude');
  let byPid: Map<number, ProcInfo> | null = null;
  const procs = () => {
    if (!byPid) {
      byPid = new Map();
      for (const g of input.groups) for (const p of flattenGroup(g)) byPid.set(p.pid, p);
    }
    return byPid;
  };
  const guard = (): GuardContext => ({ byPid: procs(), currentUid: input.currentUid, selfPid: input.selfPid, appRoot: input.appRoot, isProtected: input.isProtected });

  const toTarget = (c: Candidate): RuleTarget => {
    const { kept, refused } = filterTargets(c.pids, guard());
    const all = procs();
    const keptProcs = kept.map((pid) => all.get(pid)!);
    return {
      key: c.key, kind: c.kind, groupKey: c.group.id, label: c.label,
      memKB: keptProcs.reduce((s, p) => s + mem(p), 0),
      targets: keptProcs.map((p) => ({ pid: p.pid, startTicks: p.startTicks })),
      names: keptProcs.map((p) => p.name),
      memKBs: keptProcs.map(mem),
      excluded: refused.size,
    };
  };

  const out: RuleDecision[] = [];
  for (const rule of enabledRules) {
    const paused = state.pausedUntil.get(rule.id);
    if (paused !== undefined) {
      if (now < paused && now >= paused - QUOTA_PAUSE_MS) continue;
      state.pausedUntil.delete(rule.id);
    }
    const ready = candidatesFor(rule, input, groups, state);
    if (ready.length === 0) continue;
    // la plus grosse cible qui reste non vide après la liste « jamais tuer »
    ready.sort((a, b) => b.sizeKB - a.sizeKB);
    let target: RuleTarget | null = null;
    for (const c of ready) {
      const t = toTarget(c);
      if (t.targets.length) {
        target = t;
        break;
      }
    }
    const base = { ruleId: rule.id, ruleName: rule.name, mode: rule.mode };
    if (!target) {
      // rien à arrêter : signalé au plus une fois par RULE_COOLDOWN_MS
      const last = state.lastGuard.get(rule.id);
      if (last === undefined || now < last || now - last >= RULE_COOLDOWN_MS) {
        state.lastGuard.set(rule.id, now);
        out.push({ ...base, outcome: 'skip', reason: 'guard', target: toTarget(ready[0]!) });
      }
      continue;
    }
    const lastFire = state.lastFire.get(rule.id);
    if (lastFire !== undefined && now >= lastFire && now - lastFire < RULE_COOLDOWN_MS) {
      out.push({ ...base, outcome: 'skip', reason: 'cooldown', target });
      continue;
    }
    const used = rule.mode === 'active' ? state.actions : state.dryRuns;
    if (used.length >= MAX_ACTIONS_PER_HOUR) {
      state.pausedUntil.set(rule.id, now + QUOTA_PAUSE_MS);
      out.push({ ...base, outcome: 'skip', reason: 'hourly-quota', target });
      continue;
    }
    used.push(now);
    state.lastFire.set(rule.id, now);
    state.overSince.delete(`${rule.id}|${target.key}`);
    out.push({ ...base, outcome: 'fire', target, condition: rule.condition });
  }
  return out;
}

const eqName = (value: string) => {
  const v = value.toLowerCase();
  return (...names: (string | undefined)[]) => names.some((n) => n !== undefined && n.toLowerCase() === v);
};

/** Candidates dont la condition est remplie maintenant (durée comprise). Met à jour `overSince` / `lastInactiveCheck`. */
function candidatesFor(rule: Rule, input: EvalInput, groups: readonly Group[], state: RuleState): Candidate[] {
  const c = rule.condition;
  const { now } = input;
  switch (c.kind) {
    case 'memory': {
      const matched: Candidate[] = [];
      if (c.target === 'group') {
        const named = c.match.by === 'name' ? eqName(c.match.value) : null;
        for (const g of groups) {
          const ok = named ? named(g.label, g.rootName) : !!input.classification?.get(g.id)?.categories.includes(c.match.value as never);
          if (ok) matched.push({ key: g.id, kind: 'group', group: g, label: g.label, pids: flattenGroup(g).map((p) => p.pid), sizeKB: mem(g) });
        }
      } else if (input.classification) {
        const named = c.match.by === 'name' ? eqName(c.match.value) : null;
        for (const g of groups) {
          const insts = input.classification.get(g.id)?.instances ?? [];
          if (!insts.length) continue;
          const rootName = new Map(flattenGroup(g).map((p) => [p.pid, p.name]));
          for (const i of insts) {
            const ok = named ? named(i.label, i.signature, rootName.get(i.rootPid)) : i.category === c.match.value;
            if (ok) matched.push({ key: i.key, kind: 'instance', group: g, label: g.kind === 'project' ? `${i.label} (${g.label})` : i.label, pids: i.pids, sizeKB: mem(i) });
          }
        }
      }
      // dépassement : posé au premier tick au-dessus, effacé dès que la cible repasse sous le seuil ou disparaît
      const prefix = `${rule.id}|`;
      const over = new Set<string>();
      const ready: Candidate[] = [];
      for (const m of matched) {
        if (m.sizeKB <= c.overMB * 1024) continue;
        const k = prefix + m.key;
        over.add(k);
        let since = state.overSince.get(k);
        if (since === undefined || since > now) {
          since = now;
          state.overSince.set(k, now);
        }
        if (now - since >= c.forMin * 60_000) ready.push(m);
      }
      for (const k of [...state.overSince.keys()]) if (k.startsWith(prefix) && !over.has(k)) state.overSince.delete(k);
      return ready;
    }
    case 'inactive': {
      const last = state.lastInactiveCheck.get(rule.id);
      if (last !== undefined && now >= last && now - last < INACTIVE_CHECK_MS) return [];
      state.lastInactiveCheck.set(rule.id, now);
      if (!input.inactive || !input.classification) return [];
      const minAgeSec = c.forHours * 3600;
      const cands: { cand: Candidate; targets: KillTarget[] }[] = [];
      for (const g of groups) {
        if (g.kind !== 'project' && g.kind !== 'deleted') continue;
        const insts = input.classification.get(g.id)?.instances ?? [];
        if (!insts.length) continue;
        const byPid = new Map(flattenGroup(g).map((p) => [p.pid, p]));
        for (const i of insts) {
          if (!c.categories.includes(i.category) || i.ageSec < minAgeSec || i.launchedBy === 'claude') continue;
          const targets = i.pids.flatMap((pid) => {
            const p = byPid.get(pid);
            return p ? [{ pid, startTicks: p.startTicks }] : [];
          });
          cands.push({ cand: { key: i.key, kind: 'instance', group: g, label: `${i.label} (${g.label})`, pids: i.pids, sizeKB: mem(i) }, targets });
        }
      }
      if (!cands.length) return [];
      const active = input.inactive(cands.flatMap((x) => x.targets), now - c.forHours * HOUR_MS);
      if (!active) return [];
      return cands.filter((x) => !x.targets.some((t) => active.has(`${t.pid}:${t.startTicks}`))).map((x) => x.cand);
    }
    case 'forecast': {
      const f = input.forecast;
      if (!f || !f.held) return [];
      const { etaMin, decliningMinutes } = f.forecast;
      if (etaMin === null || !(etaMin < c.underMin) || decliningMinutes < MIN_DECLINING) return [];
      const apps = new Set(c.includeApps.map((n) => `app:${n}`));
      return groups
        .filter((g) => (input.growthKB.get(g.id) ?? 0) > 0 && (g.kind !== 'app' || apps.has(g.id)))
        .map((g) => ({ key: g.id, kind: 'group' as const, group: g, label: g.label, pids: flattenGroup(g).map((p) => p.pid), sizeKB: mem(g) }));
    }
  }
}

/** Événement de règle relu dans la base (voir ruleEventsSince). */
export interface RuleEventRow { ts: number; type: 'rule_action' | 'rule_dry_run'; ruleId: string; result: string }

/**
 * État après un redémarrage du service, d'après les événements de la dernière heure : dernier déclenchement par règle,
 * actions réelles et simulations (quotas), pauses de quota en cours. L'escalade SIGKILL n'est pas une action à part.
 */
export function restoreRuleState(rows: readonly RuleEventRow[], now: number): RuleState {
  const st = emptyRuleState();
  for (const r of rows) {
    if (r.ts > now || r.ts <= now - HOUR_MS) continue;
    if (r.result === 'quota') {
      st.pausedUntil.set(r.ruleId, Math.max(st.pausedUntil.get(r.ruleId) ?? 0, r.ts + QUOTA_PAUSE_MS));
      continue;
    }
    if (r.result === 'sigkill') continue;
    (r.type === 'rule_action' ? st.actions : st.dryRuns).push(r.ts);
    st.lastFire.set(r.ruleId, Math.max(st.lastFire.get(r.ruleId) ?? 0, r.ts));
  }
  st.actions.sort((a, b) => a - b);
  st.dryRuns.sort((a, b) => a - b);
  return st;
}
