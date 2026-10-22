// src/core/rules/engine.ts — moteur des règles automatiques (⑥). Pur : aucun effet de bord hors `state`, aucune
// horloge (instant fourni), aucun accès à /proc ni à la base (fonctions `inactive` et `isProtected` injectées).
import { checkCommand, matchCommand } from '../classify/rules';
import { HOLD_MS, MIN_DECLINING, type Forecast } from '../forecast/forecast';
import { flattenGroup, type Classification } from '../snapshot';
import type { Group, KillTarget, ProcInfo } from '../types';
import { filterTargets, type GuardContext } from './neverKill';
import { verificationKind, verificationPids } from './verification';
import type { Rule, RuleCondition, RuleMode } from './types';

export const RULE_COOLDOWN_MS = 300_000;
export const MAX_ACTIONS_PER_HOUR = 10;
export const INACTIVE_CHECK_MS = 60_000;
/** Quota horaire atteint : la règle est mise en pause pendant 1 h. */
export const QUOTA_PAUSE_MS = 3600_000;
/** (c) : seuls les groupes qui ont grossi d'au moins 100 Mio sur 5 min sont des coupables. */
export const FORECAST_MIN_GROWTH_KB = 100 * 1024;
/** (d) anti-gel, Active : délai minimal entre deux victimes (escalade SIGKILL à 5 s et mesure suivante comprises). */
export const SYSTEM_SETTLE_MS = 15_000;
/** (d) : victime toujours vivante après ce délai (signal refusé, processus bloqué) : écartée tant qu'elle vit, la suivante peut être visée. */
export const SYSTEM_STUCK_MS = 60_000;
/** (d) déclencheur mémoire ou pression : la victime pèse au moins 512 Mio et 5 % de la RAM (sinon la tuer ne libère rien d'utile). */
export const SYSTEM_MIN_MEM_KB = 512 * 1024;
export const SYSTEM_MIN_MEM_SHARE = 0.05;
/** (d) déclencheur CPU : la victime occupe au moins 10 % de la machine (tous cœurs). */
export const SYSTEM_MIN_CPU_SHARE = 10;
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
  /** Règle anti-gel : cible « vérification » (voir verification.ts), revérifiée comme telle avant chaque signal. */
  verification?: boolean;
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
  /** (d) ruleId → début (monotone) du dépassement mémoire, du dépassement CPU et de la pression mémoire, observés sans trou. */
  systemMemSince: Map<string, number>;
  systemCpuSince: Map<string, number>;
  systemPsiSince: Map<string, number>;
  /** (d) ruleId → victime en cours (clés `${pid}:${startTicks}`) et instant du déclenchement (Active seulement). */
  systemPending: Map<string, { keys: string[]; at: number }>;
  /** (d) ruleId → victimes restées vivantes après SYSTEM_STUCK_MS : plus visées tant qu'elles vivent. */
  systemStuck: Map<string, Set<string>>;
  /** (d) règles dont la condition est tenue sans aucune vérification à arrêter (évaluation courante). */
  systemNoTarget: Set<string>;
}

export const emptyRuleState = (): RuleState => ({
  overSince: new Map(), lastFire: new Map(), actions: [], dryRuns: [], lastInactiveCheck: new Map(), pausedUntil: new Map(), lastGuard: new Map(),
  lastEval: null, lastGapWall: null, forecastHeldSince: null,
  systemMemSince: new Map(), systemCpuSince: new Map(), systemPsiSince: new Map(), systemPending: new Map(), systemStuck: new Map(), systemNoTarget: new Set(),
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
  /**
   * (d) Mesures du tick : RAM utilisée en % (d'après MemAvailable), CPU total en % (toutes les cœurs = 100 %) et pression
   * mémoire en % (PSI « full » avg10). null, absente ou non finie → la condition n'est jamais tenue (échec fermé).
   */
  system?: {
    memUsedPercent: number | null; cpuPercent: number | null;
    /** /proc/pressure/memory « full avg10 » : part du temps où toutes les tâches attendaient la mémoire. */
    psiFull10?: number | null;
    /** MemTotal (Kio) et nombre de cœurs : seuils de contribution de la victime ; absents → seuil mémoire fixe, CPU jamais. */
    memTotalKB?: number | null; cpuCount?: number | null;
  } | null;
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
  /** Anti-gel lot 3 : processus des projets au frigo, jamais visés (raison `frozen`). */
  frozenPids?: ReadonlySet<number>;
}

/** `culprit-protected` : (c) le plus gros responsable de la croissance est intouchable, rien n'est visé. */
export type SkipReason = 'cooldown' | 'hourly-quota' | 'guard' | 'culprit-protected';
export type RuleDecision =
  | {
    ruleId: string; ruleName: string; mode: RuleMode; outcome: 'fire'; target: RuleTarget; condition: RuleCondition; revision: string;
    /** (d) mesure qui a déclenché (« mémoire 97 % depuis 15 s », « pression mémoire 52 % depuis 20 s »), pour l'historique. */
    trigger?: string;
  }
  | { ruleId: string; ruleName: string; mode: RuleMode; outcome: 'skip'; reason: SkipReason; target: RuleTarget | null };

/** Règle activée de type instance, catégorie, inactive ou prévision : le service doit classer les groupes (pas l'anti-gel, qui lit les lignes de commande). */
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
  /** Vérification (règle anti-gel) : lancée par Claude, elle reste visable (voir verification.ts). */
  verification?: boolean;
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
    state.systemMemSince.clear();
    state.systemCpuSince.clear();
    state.systemPsiSince.clear();
    state.lastGapWall = Math.max(wall, last.wall);
  }
  state.lastEval = { mono: now, wall };
  const enabledRules = input.rules.filter((r) => r.enabled);
  // état des règles retirées ou désactivées
  const live = new Set(enabledRules.map((r) => r.id));
  for (const k of state.overSince.keys()) if (!live.has(k.slice(0, k.indexOf('|')))) state.overSince.delete(k);
  for (const m of [state.systemMemSince, state.systemCpuSince, state.systemPsiSince, state.systemPending, state.systemStuck]) {
    for (const k of m.keys()) if (!live.has(k)) m.delete(k);
  }
  state.systemNoTarget.clear();
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
  // pids du groupe Claude (outils détachés compris) : refusés comme dans le ruleRunner, avant tout déclenchement
  let claudePids: Set<number> | null = null;
  const guard = (): GuardContext => ({
    byPid: procs(), currentUid: input.currentUid, selfPid: input.selfPid, appRoot: input.appRoot, isProtected: input.isProtected,
    claudePids: (claudePids ??= new Set(input.groups.filter((g) => g.kind === 'claude').flatMap((g) => flattenGroup(g).map((p) => p.pid)))),
    frozen: input.frozenPids,
  });

  let verifPids: Set<number> | null = null;
  const toTarget = (c: Candidate): RuleTarget => {
    const ctx = guard();
    if (c.verification) ctx.verification = (verifPids ??= verificationPids(procs()));
    const { kept, refused } = filterTargets(c.pids, ctx);
    const all = procs();
    const keptProcs = kept.map((pid) => all.get(pid)!);
    return {
      key: c.key, kind: c.kind, groupKey: c.group.id, label: c.label,
      memKB: keptProcs.reduce((s, p) => s + mem(p), 0),
      targets: keptProcs.map((p) => ({ pid: p.pid, startTicks: p.startTicks })),
      names: keptProcs.map((p) => p.name),
      memKBs: keptProcs.map(mem),
      excluded: refused.size,
      ...(c.verification ? { verification: true } : {}),
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
    if (ready.length === 0) {
      // (d) condition tenue, aucune vérification à arrêter : signalé au plus une fois par RULE_COOLDOWN_MS
      if (state.systemNoTarget.has(rule.id)) {
        const lastGuard = state.lastGuard.get(rule.id);
        if (lastGuard === undefined || now - lastGuard >= RULE_COOLDOWN_MS) {
          state.lastGuard.set(rule.id, now);
          out.push({ ruleId: rule.id, ruleName: rule.name, mode: rule.mode, outcome: 'skip', reason: 'guard', target: null });
        }
      }
      continue;
    }
    // (c) : si le principal responsable de la croissance (processus ou instance) est refusé (Claude, protégé, jamais
    // tuer), arrêter un plus petit ne libérerait pas assez : rien, signalé au plus une fois par RULE_COOLDOWN_MS.
    if (rule.condition.kind === 'forecast' && topGrowerRefused(input, procs(), guard())) {
      const lastGuard = state.lastGuard.get(rule.id);
      if (lastGuard === undefined || now - lastGuard >= RULE_COOLDOWN_MS) {
        state.lastGuard.set(rule.id, now);
        out.push({ ruleId: rule.id, ruleName: rule.name, mode: rule.mode, outcome: 'skip', reason: 'culprit-protected', target: null });
      }
      continue;
    }
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
    // (d) Active : pas de cooldown fixe, mais une victime à la fois (attente de sa mort, voir candidatesFor)
    const oneAtATime = rule.condition.kind === 'system' && rule.mode === 'active';
    // un dernier déclenchement « dans le futur » compte comme maintenant : cooldown
    if (!oneAtATime && lastFire !== undefined && now - lastFire < RULE_COOLDOWN_MS) {
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
    if (oneAtATime) state.systemPending.set(rule.id, { keys: target.targets.map((t) => `${t.pid}:${t.startTicks}`), at: now });
    const trigger = rule.condition.kind === 'system' ? systemTrigger(rule.condition, rule.id, input, state, now) : undefined;
    out.push({ ...base, outcome: 'fire', target, condition: rule.condition, revision: ruleRevision(rule), ...(trigger ? { trigger } : {}) });
  }
  return out;
}

/** Le processus, ou l'instance, qui a le plus grossi sur 5 min (tous groupes) contient-il un processus refusé ? */
function topGrowerRefused(input: EvalInput, byPid: ReadonlyMap<number, ProcInfo>, guard: GuardContext): boolean {
  const growth = input.procGrowthKB;
  if (!growth) return false;
  const g = (p: ProcInfo | undefined) => (p ? growth.get(`${p.pid}:${p.startTicks}`) ?? 0 : 0);
  let topPid: number | null = null;
  let topKB = -Infinity;
  for (const p of byPid.values()) {
    const kb = g(p);
    if (kb > topKB) {
      topKB = kb;
      topPid = p.pid;
    }
  }
  let topInst: readonly number[] | null = null;
  let instKB = -Infinity;
  for (const c of input.classification?.values() ?? []) {
    for (const i of c.instances) {
      const kb = i.pids.reduce((s, pid) => s + g(byPid.get(pid)), 0);
      if (kb > instKB) {
        instKB = kb;
        topInst = i.pids;
      }
    }
  }
  if (topPid !== null && topKB > 0 && filterTargets([topPid], guard).refused.size > 0) return true;
  if (topInst && instKB > 0 && filterTargets(topInst, guard).refused.size > 0) return true;
  return false;
}

/**
 * (d) RAM utilisée en %, d'après MemAvailable (comme `free`) ; null si /proc/meminfo est incohérent (ligne
 * MemAvailable absente, total nul ou absent, disponible négatif ou non fini).
 */
export function memUsedPercent(s: { memTotalKB: number; memAvailableKB: number; memAvailableKnown?: boolean }): number | null {
  if (s.memAvailableKnown === false) return null;
  const total = s.memTotalKB;
  const avail = s.memAvailableKB;
  if (!(Number.isFinite(total) && total > 0) || !(Number.isFinite(avail) && avail >= 0)) return null;
  return ((total - Math.min(avail, total)) / total) * 100;
}

/** Pourcentage mesuré utilisable (fini) ; sinon null (mesure absente ou illisible). */
const pct = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * (d) « mémoire 97 % depuis 15 s », « pression mémoire 52 % depuis 20 s » ou « CPU 99 % depuis 60 s » : la mesure tenue
 * (la mémoire d'abord, puis la pression, puis le CPU).
 */
function systemTrigger(c: Extract<RuleCondition, { kind: 'system' }>, ruleId: string, input: EvalInput, state: RuleState, now: number): string | undefined {
  const held = (v: number | null, since: number | undefined, forSec: number | undefined) =>
    v !== null && since !== undefined && forSec !== undefined && now - since >= forSec * 1000;
  const mem = pct(input.system?.memUsedPercent);
  const psi = pct(input.system?.psiFull10);
  const cpu = pct(input.system?.cpuPercent);
  const memSince = state.systemMemSince.get(ruleId);
  const psiSince = state.systemPsiSince.get(ruleId);
  const cpuSince = state.systemCpuSince.get(ruleId);
  const sec = (since: number) => Math.round((now - since) / 1000);
  if (held(mem, memSince, c.memForSec)) return `mémoire ${Math.round(mem!)} % depuis ${sec(memSince!)} s`;
  if (held(psi, psiSince, c.psiForSec)) return `pression mémoire ${Math.round(psi!)} % depuis ${sec(psiSince!)} s`;
  if (held(cpu, cpuSince, c.cpuForSec)) return `CPU ${Math.round(cpu!)} % depuis ${sec(cpuSince!)} s`;
  return undefined;
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
    case 'system': {
      // tenue : posée à la première mesure au-dessus, effacée dès une mesure en dessous, absente ou illisible
      const track = (m: Map<string, number>, v: number | null, threshold: number, forSec: number): boolean => {
        if (v === null || !(v >= threshold)) {
          m.delete(rule.id);
          return false;
        }
        let since = m.get(rule.id);
        if (since === undefined || since > now) {
          since = now;
          m.set(rule.id, now);
        }
        return now - since >= forSec * 1000;
      };
      const memHeld = track(state.systemMemSince, pct(input.system?.memUsedPercent), c.memPercent, c.memForSec);
      const cpuHeld = track(state.systemCpuSince, pct(input.system?.cpuPercent), c.cpuPercent, c.cpuForSec);
      // pression mémoire (PSI full) : seulement si la condition en a une (une condition d'avant la pression n'en tient pas compte)
      const psiHeld = c.psiPercent !== undefined && c.psiForSec !== undefined
        ? track(state.systemPsiSince, pct(input.system?.psiFull10), c.psiPercent, c.psiForSec)
        : (state.systemPsiSince.delete(rule.id), false);
      // processus vivants (pid + startTicks) : victime précédente encore là ?
      const alive = new Set<string>();
      for (const g of input.groups) for (const p of flattenGroup(g)) alive.add(`${p.pid}:${p.startTicks}`);
      const stuck = state.systemStuck.get(rule.id);
      if (stuck) {
        for (const k of [...stuck]) if (!alive.has(k)) stuck.delete(k);
        if (!stuck.size) state.systemStuck.delete(rule.id);
      }
      // une victime à la fois, toutes règles système confondues : une autre règle attend la sienne → rien
      for (const id of state.systemPending.keys()) if (id !== rule.id) return [];
      const pending = state.systemPending.get(rule.id);
      if (pending) {
        if (pending.at > now) pending.at = now;
        const elapsed = now - pending.at;
        const waiting = pending.keys.filter((k) => alive.has(k));
        // une victime à la fois : stabilisation après le signal, puis attente de sa mort (bornée)
        if (elapsed < SYSTEM_SETTLE_MS || (waiting.length && elapsed < SYSTEM_STUCK_MS)) return [];
        if (waiting.length) {
          const set = state.systemStuck.get(rule.id) ?? new Set<string>();
          for (const k of waiting) set.add(k);
          state.systemStuck.set(rule.id, set);
        }
        state.systemPending.delete(rule.id);
      }
      if (!(memHeld || cpuHeld || psiHeld)) return [];
      const skip = state.systemStuck.get(rule.id) ?? new Set<string>();
      // Tous les processus connus hors « Autres », Claude compris (accord de l'utilisateur du 2026-10-19 : une vérification
      // lancée par Claude est visable par cette règle) : une vérification emmène ses descendants rangés ailleurs (workers
      // Node au comm « MainThread », rangés dans leur propre groupe de commande).
      const byPid = new Map<number, ProcInfo>();
      const groupOf = new Map<number, Group>();
      for (const g of input.groups) if (g.kind !== 'others') for (const p of flattenGroup(g)) {
        byPid.set(p.pid, p);
        groupOf.set(p.pid, g);
      }
      const children = new Map<number, number[]>();
      for (const p of byPid.values()) if (p.ppid !== p.pid) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
      const subtree = (roots: readonly number[]): number[] => {
        // parcours en profondeur, racines et enfants dans l'ordre (racine d'abord)
        const seen = new Set<number>();
        const stack = [...roots].reverse();
        while (stack.length) {
          const pid = stack.pop()!;
          if (seen.has(pid) || !byPid.has(pid)) continue;
          seen.add(pid);
          stack.push(...[...(children.get(pid) ?? [])].reverse());
        }
        return [...seen].filter((pid) => !skip.has(`${pid}:${byPid.get(pid)!.startTicks}`));
      };
      const size = (pids: readonly number[]) => pids.reduce((s, pid) => s + mem(byPid.get(pid)!), 0);
      const label = (l: string, g: Group | undefined) => (g?.kind === 'project' ? `${l} (${g.label})` : l);
      // Cibles « vérifications », reconnues processus par processus à leur ligne de commande, comme le classement
      // (jamais au comm « MainThread » de Node ≥ 24, jamais d'après la racine d'une instance ou d'un groupe) : lanceur de
      // tests (vitest, jest, pytest, playwright test…) ou tsc (hors --watch) / eslint ; le plus haut seulement, avec ses
      // descendants. Dans tous les groupes sauf « Autres » ; les garde-fous filtrent ensuite (Claude lui-même, shells,
      // protégés…).
      const kinds = new Map<number, string>();
      for (const p of byPid.values()) {
        const k = verificationKind(p);
        if (k) kinds.set(p.pid, k);
      }
      // seuil de contribution : la victime doit peser dans la saturation (sinon, rien à arrêter)
      const sys = input.system;
      const totalKB = sys?.memTotalKB;
      const minMemKB = Math.max(SYSTEM_MIN_MEM_KB, typeof totalKB === 'number' && Number.isFinite(totalKB) && totalKB > 0 ? totalKB * SYSTEM_MIN_MEM_SHARE : 0);
      const ncpu = sys?.cpuCount;
      const cpuShare = (pids: readonly number[]) =>
        typeof ncpu === 'number' && Number.isFinite(ncpu) && ncpu >= 1
          ? pids.reduce((s, pid) => s + (Number.isFinite(byPid.get(pid)!.cpuPercent) ? byPid.get(pid)!.cpuPercent : 0), 0) / ncpu
          : 0;
      const out: Candidate[] = [];
      for (const [pid, k] of kinds) {
        // la vérification la plus haute seulement (un eslint sous un autre est compris dans celui du dessus)
        let nested = false;
        const seen = new Set<number>([pid]);
        for (let up = byPid.get(pid)!.ppid; byPid.has(up) && !seen.has(up); up = byPid.get(up)!.ppid) {
          seen.add(up);
          if (kinds.has(up)) nested = true;
        }
        if (nested) continue;
        const pids = subtree([pid]);
        if (!pids.length) continue;
        const sizeKB = size(pids);
        // pression mémoire comme mémoire pleine : la victime doit peser en mémoire
        if (!(((memHeld || psiHeld) && sizeKB >= minMemKB) || (cpuHeld && cpuShare(pids) >= SYSTEM_MIN_CPU_SHARE))) continue;
        const p = byPid.get(pid)!;
        const g = groupOf.get(pid)!;
        out.push({ key: `check:${p.pid}:${p.startTicks}`, kind: 'instance', group: g, label: label(k, g), pids, sizeKB, verification: true });
      }
      if (!out.length) state.systemNoTarget.add(rule.id);
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
