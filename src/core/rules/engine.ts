// src/core/rules/engine.ts — moteur des règles automatiques (⑥). Pur : aucun effet de bord hors `state`, aucune
// horloge (instant fourni), aucun accès à /proc ni à la base (fonctions `inactive` et `isProtected` injectées).
import { HOLD_MS, MIN_DECLINING, type Forecast } from '../forecast/forecast';
import { flattenGroup, type Classification } from '../snapshot';
import type { Group, KillTarget, ProcInfo } from '../types';
import { filterTargets, type GuardContext } from './neverKill';
import type { Rule, RuleCondition, RuleMode } from './types';

export const RULE_COOLDOWN_MS = 300_000;
export const MAX_ACTIONS_PER_HOUR = 10;
export const INACTIVE_CHECK_MS = 60_000;
/** Quota horaire atteint : la règle est mise en pause pendant 1 h. */
export const QUOTA_PAUSE_MS = 3600_000;
/** (c) : seuls les groupes qui ont grossi d'au moins 100 Mio sur 5 min sont des coupables. */
export const FORECAST_MIN_GROWTH_KB = 100 * 1024;
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
  /** Dernière évaluation (horloges monotone et murale) : détecte les trous (veille, saut d'horloge). */
  lastEval: { mono: number; wall: number } | null;
  /** Instant mural du dernier trou : « inactive depuis T » exige une période observée sans trou. */
  lastGapWall: number | null;
  /** Début (monotone) de la condition de prévision tenue, observée sans trou. */
  forecastHeldSince: number | null;
}

export const emptyRuleState = (): RuleState => ({
  overSince: new Map(), lastFire: new Map(), actions: [], dryRuns: [], lastInactiveCheck: new Map(), pausedUntil: new Map(), lastGuard: new Map(),
  lastEval: null, lastGapWall: null, forecastHeldSince: null,
});

/**
 * Horloges : tous les instants de l'état (cooldown, quotas, pauses, durées) sont MONOTONES (`now`) ; seuls l'historique et
 * l'inactivité utilisent l'heure murale (`wallNow`). Un instant de l'état dans le futur compte comme « maintenant » :
 * un recul d'horloge ne libère jamais un quota ni ne lève une pause.
 */
export interface EvalInput {
  /** Horloge monotone (ms). */
  now: number;
  /** Horloge murale (ms) ; absente → `now`. */
  wallNow?: number;
  /**
   * Écart monotone maximal entre deux évaluations (4 × intervalle : un ralentissement du service est toléré) ; au-delà,
   * ou si une horloge recule, les durées repartent.
   */
  maxGapMs?: number;
  /** Écart maximal entre les avances murale et monotone (2 × intervalle) : au-delà, veille ou saut d'horloge. */
  maxSkewMs?: number;
  /** Interrupteur général « Règles automatiques » : éteint → aucune décision, aucun appel. */
  enabled: boolean;
  rules: readonly Rule[];
  groups: readonly Group[];
  classification: Classification | null;
  /** Prévision ② et décision de stepAlert : `held` = condition d'alerte tenue (≥ 30 s), sans l'anti-répétition. */
  forecast: { forecast: Forecast; held: boolean } | null;
  /** `${pid}:${startTicks}` → hausse mémoire sur 5 min (ProcGrowth) ; null sans 5 min observées. */
  procGrowthKB: ReadonlyMap<string, number> | null;
  /** clés `${pid}:${startTicks}` ACTIVES depuis `sinceMs` ; null sans historique couvrant la période */
  inactive: ((targets: KillTarget[], sinceMs: number) => Set<string> | null) | null;
  isProtected: (name: string) => boolean;
  appRoot: string | null;
  currentUid: number;
  selfPid: number;
}

export type SkipReason = 'cooldown' | 'hourly-quota' | 'guard';
export type RuleDecision =
  | { ruleId: string; ruleName: string; mode: RuleMode; outcome: 'fire'; target: RuleTarget; condition: RuleCondition; revision: string }
  | { ruleId: string; ruleName: string; mode: RuleMode; outcome: 'skip'; reason: SkipReason; target: RuleTarget | null };

/** Règle activée de type instance, catégorie ou inactive : le service doit classer les groupes. */
export function needsClassification(rules: readonly Rule[], enabled = true): boolean {
  if (!enabled) return false;
  return rules.some((r) => r.enabled && (r.condition.kind === 'inactive' || r.condition.kind === 'forecast' ||
    (r.condition.kind === 'memory' && (r.condition.target === 'instance' || r.condition.match.by === 'category'))));
}

const mem = (p: { rssKB: number; swapKB: number }) => p.rssKB + p.swapKB;

/** Révision d'une règle : la règle telle qu'enregistrée. Une escalade SIGKILL n'a lieu que si elle n'a pas changé. */
export const ruleRevision = (r: Rule): string => JSON.stringify(r);

/** Candidate avant filtrage : clé, groupe, libellé, pids, taille ; `growthKB` (prévision) classe avant la taille. */
interface Candidate {
  key: string; kind: 'instance' | 'group'; group: Group; label: string; pids: number[]; sizeKB: number; growthKB?: number;
  /** Cible entière ou rien : écartée si un de ses processus est refusé (croissance attribuée à l'instance). */
  attributable?: boolean;
}

export function evaluateRules(input: EvalInput, state: RuleState): RuleDecision[] {
  if (!input.enabled) return [];
  const { now } = input;
  const wall = input.wallNow ?? now;
  // Trou entre deux évaluations (veille, saut ou recul d'une horloge) : toutes les durées observées repartent de zéro.
  const last = state.lastEval;
  const maxGap = input.maxGapMs ?? Infinity;
  const maxSkew = input.maxSkewMs ?? maxGap;
  if (last && (now < last.mono || now - last.mono > maxGap || wall < last.wall || Math.abs((wall - last.wall) - (now - last.mono)) > maxSkew)) {
    state.overSince.clear();
    state.forecastHeldSince = null;
    state.lastGapWall = Math.max(wall, last.wall);
  }
  state.lastEval = { mono: now, wall };
  const enabledRules = input.rules.filter((r) => r.enabled);
  // état des règles retirées ou désactivées
  const live = new Set(enabledRules.map((r) => r.id));
  for (const k of state.overSince.keys()) if (!live.has(k.slice(0, k.indexOf('|')))) state.overSince.delete(k);
  // fenêtre glissante d'1 h : un instant dans le futur reste compté (échec fermé)
  const cut = now - HOUR_MS;
  state.actions = state.actions.filter((t) => t > cut);
  state.dryRuns = state.dryRuns.filter((t) => t > cut);
  // prévision tenue, observée par le moteur sans trou
  const held = !!input.forecast?.held;
  if (!held) state.forecastHeldSince = null;
  else if (state.forecastHeldSince === null || state.forecastHeldSince > now) state.forecastHeldSince = now;
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
      if (now < paused) continue;
      state.pausedUntil.delete(rule.id);
    }
    const ready = candidatesFor(rule, input, groups, state);
    if (ready.length === 0) continue;
    // la plus forte croissance (prévision), puis la plus grosse cible, qui reste non vide après la liste « jamais tuer »
    ready.sort((a, b) => (b.growthKB ?? 0) - (a.growthKB ?? 0) || b.sizeKB - a.sizeKB);
    let target: RuleTarget | null = null;
    for (const c of ready) {
      const t = toTarget(c);
      // (c) : une instance dont un processus est refusé (Claude, protégé, jamais tuer…) n'a pas de croissance attribuable
      if (t.targets.length && !(c.attributable && t.excluded > 0)) {
        target = t;
        break;
      }
    }
    const base = { ruleId: rule.id, ruleName: rule.name, mode: rule.mode };
    if (!target) {
      // rien à arrêter : signalé au plus une fois par RULE_COOLDOWN_MS
      const lastGuard = state.lastGuard.get(rule.id);
      if (lastGuard === undefined || now - lastGuard >= RULE_COOLDOWN_MS) {
        state.lastGuard.set(rule.id, now);
        out.push({ ...base, outcome: 'skip', reason: 'guard', target: toTarget(ready[0]!) });
      }
      continue;
    }
    const lastFire = state.lastFire.get(rule.id);
    // un dernier déclenchement « dans le futur » compte comme maintenant : cooldown
    if (lastFire !== undefined && now - lastFire < RULE_COOLDOWN_MS) {
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
    out.push({ ...base, outcome: 'fire', target, condition: rule.condition, revision: ruleRevision(rule) });
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
      const wall = input.wallNow ?? now;
      const since = wall - c.forHours * HOUR_MS;
      // un trou dans la période (veille, saut d'horloge) : activité inconnue, rien n'est « inactif »
      if (state.lastGapWall !== null && since < state.lastGapWall) return [];
      const last = state.lastInactiveCheck.get(rule.id);
      if (last !== undefined && now - last < INACTIVE_CHECK_MS) return [];
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
      const active = input.inactive(cands.flatMap((x) => x.targets), since);
      if (!active) return [];
      return cands.filter((x) => !x.targets.some((t) => active.has(`${t.pid}:${t.startTicks}`))).map((x) => x.cand);
    }
    case 'forecast': {
      const f = input.forecast;
      if (!f || !f.held) return [];
      // tenue et observée sans trou pendant HOLD_MS par le moteur lui-même
      if (state.forecastHeldSince === null || now - state.forecastHeldSince < HOLD_MS) return [];
      const { etaMin, decliningMinutes } = f.forecast;
      if (etaMin === null || !(etaMin < c.underMin) || decliningMinutes < MIN_DECLINING) return [];
      // Croissance attribuée par INSTANCE (somme de ses processus) : jamais au groupe, dont la hausse peut venir d'un processus
      // intouchable (vitest lancé par Claude) et tuerait ses voisins. Par défaut seulement les instances de projets (et
      // dossiers supprimés) ; une appli seulement si elle est cochée ; jamais une commande.
      const growth = input.procGrowthKB;
      if (!growth || !input.classification) return [];
      const apps = new Set(c.includeApps.map((n) => `app:${n}`));
      const out: Candidate[] = [];
      for (const g of groups) {
        if (!(g.kind === 'project' || g.kind === 'deleted' || (g.kind === 'app' && apps.has(g.id)))) continue;
        const insts = input.classification.get(g.id)?.instances ?? [];
        if (!insts.length) continue;
        const byPid = new Map(flattenGroup(g).map((p) => [p.pid, p]));
        for (const i of insts) {
          let kb = 0;
          let known = true;
          for (const pid of i.pids) {
            const p = byPid.get(pid);
            const d = p ? growth.get(`${p.pid}:${p.startTicks}`) : undefined;
            if (d === undefined) known = false;
            else kb += d;
          }
          if (!known || kb < FORECAST_MIN_GROWTH_KB) continue;
          out.push({ key: i.key, kind: 'instance', group: g, label: g.kind === 'project' ? `${i.label} (${g.label})` : i.label, pids: i.pids, sizeKB: mem(i), growthKB: kb, attributable: true });
        }
      }
      return out;
    }
  }
}

/** Événement de règle relu dans la base (voir ruleEventsSince). */
export interface RuleEventRow { ts: number; type: 'rule_action' | 'rule_dry_run'; ruleId: string; result: string }

/**
 * État après un redémarrage du service, d'après les événements de la dernière heure : dernier déclenchement par règle,
 * actions réelles et simulations (quotas), pauses de quota en cours. L'escalade SIGKILL n'est pas une action à part.
 */
export function restoreRuleState(rows: readonly RuleEventRow[], wallNow: number, monoNow: number = wallNow, lastRecorded: number | null = null): RuleState {
  const st = emptyRuleState();
  // Référence : la dernière mesure enregistrée avant le redémarrage si elle est plus ancienne que l'heure murale (un saut
  // en avant pendant l'arrêt ne vieillit pas les actions) ; un arrêt réel prolonge donc quotas et cooldown (échec fermé).
  const ref = lastRecorded !== null && lastRecorded < wallNow ? lastRecorded : wallNow;
  // instant mural → monotone ; un événement daté dans le futur (horloge revenue en arrière) compte comme « maintenant »
  const toMono = (ts: number) => monoNow - Math.max(0, ref - ts);
  for (const r of rows) {
    if (ref - r.ts >= HOUR_MS) continue;
    const t = toMono(r.ts);
    if (r.result === 'quota') {
      st.pausedUntil.set(r.ruleId, Math.max(st.pausedUntil.get(r.ruleId) ?? -Infinity, t + QUOTA_PAUSE_MS));
      continue;
    }
    if (r.result === 'sigkill') continue;
    (r.type === 'rule_action' ? st.actions : st.dryRuns).push(t);
    st.lastFire.set(r.ruleId, Math.max(st.lastFire.get(r.ruleId) ?? -Infinity, t));
  }
  st.actions.sort((a, b) => a - b);
  st.dryRuns.sort((a, b) => a - b);
  return st;
}
