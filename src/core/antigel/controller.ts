// Anti-gel (lot 1) : orchestration par tick du service. Plafonds de cwatch.slice, une slice par projet (budget : freinage,
// part de swap, plafond dur), un scope neuf par lot de déplacement (amendement A1), OOM et ralentissements lus sur la slice
// du projet. Les appels D-Bus partent en arrière-plan, un enchaînement à la fois : le tick n'attend jamais busctl, et en
// régime établi il ne fait aucun appel.
//
// Ordre garanti dans un enchaînement : cwatch.slice assurée (plafonds) avant toute slice de projet ; slice de projet
// assurée (budget ou infinity) dans ce processus avant tout scope rangé dedans : jamais de scope vers une slice que systemd
// créerait vide. Un échec de cwatch.slice (ou du gestionnaire : refus, injoignable, délai) arrête l'enchaînement ; un échec
// propre à un projet (son budget, sa slice, son scope) n'arrête que la suite de ce projet, les autres projets continuent.
import type { Group, ProcInfo, SystemInfo } from '../types';
import type { Availability, CgroupStats, MemoryEvents } from './cgroupfs';
import { effectiveBudget, type AntigelConfig } from './config';
import { createDeskPriority, type DeskDeps } from './desk';
import { convergingMax, dynamicLimits, projectCaps, sameCaps, sameLimits, sliceLimits, type ProjectCaps, type SliceLimits } from './limits';
import { createRecent, type Recent } from './recent';
import { MIN_ROOT_AGE_SEC, planMoves, type PlanMove, type PlanTarget } from './plan';
import type { AntigelProjectState, AntigelSliceState, AntigelState } from './state';
import { BusctlError, MAX_PIDS, type SystemdClient } from './systemd';
import { hashedProjectSlice } from './run';
import { RUN_RETRY_MS, runPidsOf, runSliceRoot, type RunScopeDeps } from './runScopes';
import { OTHERS_SLICE, ROOT_SLICE, isProdProjectSliceName, newScopeName, projectSliceFor, shortHash, slicePath, slugOf } from './units';

export const PROBE_EVERY_MS = 300_000;
export const THROTTLE_HOLD_MS = 15_000;
/** Recul avant un nouvel essai d'un budget en échec (autre que « no-unit ») : pas un busctl par tick. */
export const BUDGET_RETRY_MS = 60_000;
/**
 * Racine de travail refusée « young » (plus jeune que MIN_ROOT_AGE_SEC) : nouvelle passe dans ce délai plutôt qu'au tick
 * suivant (5 s par défaut), le temps que la mémoire allouée hors budget reste petite. Égal à MIN_ROOT_AGE_SEC : une racine
 * jeune a toujours l'âge voulu à la passe suivante, une seule passe de plus par racine.
 */
export const RECHECK_YOUNG_MS = MIN_ROOT_AGE_SEC * 1000;
const CGROUP_MAX_AGE_MS = 60_000;
/** Entrées au plus dans `slices` et `projects` de l'état (borne de parseAntigelState). */
const MAX_UNITS = 200;
const RESERVE_TOO_BIG = 'réserve trop grande : moins de 1 Go laissé au travail';
/**
 * Mémoire hors budget publiée seulement au-delà de ces seuils (mémoire anonyme des processus de la slice moins
 * memory.current) : memory.current compte aussi le cache de fichiers, et la mémoire partagée après un fork compte double.
 */
export const OUTSIDE_MIN_KB = 512 * 1024;
export const OUTSIDE_MIN_RATIO = 0.2;
/** Mémoire comptée ailleurs (Ko) si elle est nette, sinon undefined. */
export function outsideKB(anonKB: number, currentKB: number): number | undefined {
  const d = anonKB - currentKB;
  return d > OUTSIDE_MIN_KB && d > OUTSIDE_MIN_RATIO * currentKB ? d : undefined;
}

export interface AntigelDeps {
  client: SystemdClient;
  /** Disponibilité (cgroups v2, gestionnaire utilisateur, contrôleur memory, busctl) : au démarrage, puis toutes les 5 min tant qu'elle manque. */
  probe: () => Availability;
  /** Mémoire d'un cgroup (« /user.slice/… »), null s'il n'existe pas. */
  stats: (cgroupPath: string) => CgroupStats | null;
  /** cgroup actuel d'un processus (null : illisible). */
  cgroupOf: (pid: number) => string | null;
  /** Revérification juste avant l'appel : uid, starttime et cgroup inchangés. */
  reverify: (targets: readonly PlanTarget[], cgroup: string) => PlanTarget[];
  monoNow: () => number;
  log: (msg: string) => void;
  /** Horloge du coût mesuré (défaut : performance.now). */
  perfNow?: () => number;
  /** Attribution slice de projet → racine relue dans antigel-state.json au démarrage (champ `slices`). */
  initialSlices?: Record<string, string | null>;
  /** Cache « pid:startTicks » → travail (défaut : neuf) ; injecté par les tests pour en suivre la taille. */
  workMemo?: Map<string, boolean>;
  /** Lot 4 (`computer-watcher run`) : entrées d'un dossier de cgroup, PIDs d'un cgroup (cgroup.procs), dossier courant d'un PID. */
  run?: RunScopeDeps;
  /** Bureau prioritaire (lot 2) : poids et protection des unités du bureau ; absent : rien. */
  desk?: Omit<DeskDeps, 'monoNow' | 'log'>;
}

export interface AntigelTickInput {
  ts: number;
  procs: readonly ProcInfo[];
  groups: readonly Group[];
  system: SystemInfo;
  config: AntigelConfig;
  currentUid: number;
  selfPid: number;
  appRoot: string | null;
  isProtected: (name: string) => boolean;
  home: string;
  /** Dossiers de config de Claude (comme pour buildGroups) : shells de l'outil Bash. */
  claudeDirs?: readonly string[];
  /** Racine de projet d'un dossier (comme le regroupement) : attribution des slices ouvertes par `computer-watcher run`. */
  projectRootOf?: (cwd: string) => string | null;
  /** Lot 3 : slices de projet au frigo (gelées) : rien n'y est rangé, systemd refuserait le scope (« Cannot start frozen unit »). */
  frozenSlices?: ReadonlySet<string>;
}

/**
 * `unit` : slice du projet (cwatch-p-<clé>.slice). `budget` : le noyau a manqué de mémoire sous la limite de la slice
 * elle-même (« oom » de son memory.events : le plafond dur de son budget) ; absent : limite d'un parent (plafond global)
 * ou mémoire du système entier.
 */
export interface AntigelOom { unit: string; root: string | null; kills: number; budget?: boolean }

export interface AntigelController {
  /** Un tick (synchrone, borné) ; renvoie les OOM observés dans les slices de projet depuis le tick précédent. */
  tick(i: AntigelTickInput): AntigelOom[];
  state(): AntigelState;
  /** Attend la fin de l'enchaînement D-Bus en vol (tests, arrêt). */
  idle(): Promise<void>;
  /** Délai avant une passe rapprochée (racine de travail refusée « young » au dernier tick, plafond actif), null sinon. */
  recheckMs(): number | null;
}

/** `critical` : son échec arrête tout l'enchaînement (cwatch.slice) ; sinon seule l'étape échoue. */
type Step = { run: () => Promise<void>; critical?: boolean };

const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
const kb = (b: number) => Math.round(b / 1024);
const toSlice = (s: CgroupStats): AntigelSliceState => ({
  currentKB: kb(s.currentBytes),
  highKB: s.highBytes === null ? null : kb(s.highBytes),
  maxKB: s.maxBytes === null ? null : kb(s.maxBytes),
  swapMaxKB: s.swapMaxBytes === null ? null : kb(s.swapMaxBytes),
  throttles: s.events.high,
  oomKills: s.events.oomKill,
});
const capped = (s: CgroupStats | null) => s !== null && (s.highBytes !== null || s.maxBytes !== null || s.swapMaxBytes !== null);

/** Racine de projet par pid : groupes `project:` (sous-groupes de « Autres » compris), jamais « / » ni le dossier personnel. */
function projectsByPid(groups: readonly Group[], home: string): Map<number, string> {
  const out = new Map<number, string>();
  const h = trim(home);
  const visit = (g: Group) => {
    if (g.kind === 'project' && g.id.startsWith('project:')) {
      const root = g.id.slice('project:'.length);
      if (trim(root) !== '/' && trim(root) !== h) for (const pid of g.pids) out.set(pid, root);
    }
    g.subgroups.forEach(visit);
  };
  groups.forEach(visit);
  return out;
}

/**
 * La slice a-t-elle pu être attribuée à cette racine par projectSliceFor ? (slice « autres » ⇔ hors projet ; sinon
 * cwatch-p-<slug>.slice ou cwatch-p-<slug>_<hash>.slice de cette racine). Écarte une attribution relue ou retrouvée
 * incohérente : jamais le budget d'un projet sur la slice d'un autre.
 */
function plausible(slice: string, root: string | null): boolean {
  if (!isProdProjectSliceName(slice)) return false;
  if (root === null) return slice === OTHERS_SLICE;
  if (typeof root !== 'string' || !root.startsWith('/') || slice === OTHERS_SLICE) return false;
  const slug = slugOf(root);
  return slice === `cwatch-p-${slug}.slice` || slice === `cwatch-p-${slug}_${shortHash(root)}.slice`;
}

export function createAntigel(deps: AntigelDeps): AntigelController {
  const perfNow = deps.perfNow ?? (() => performance.now());
  const client = deps.client;
  const desk = deps.desk ? createDeskPriority({ ...deps.desk, monoNow: deps.monoNow, log: deps.log }) : null;
  const dbusCalls = () => client.calls() + (desk?.calls() ?? 0);
  let avail: Availability | null = null;
  let probedAt = 0;
  /** Plafonds posés sur cwatch.slice par ce processus (null : rien posé depuis le démarrage, ou remis à infinity). */
  let applied: SliceLimits | null = null;
  /** cwatch.slice remise à infinity par ce processus (une seule fois, même si sysfs montre encore une valeur). */
  let rootReset = false;
  /** Attribution slice de projet → racine (null : hors projet), jamais deux slices pour une racine ni deux racines pour une slice. */
  const slices = new Map<string, string | null>();
  /** Slices de projet assurées (StartTransientUnit ou propriété posée) par ce processus. */
  const ensured = new Set<string>();
  /** Plafonds posés par ce processus sur chaque slice de projet (budget, plafond dur, part de swap ; null : infinity). */
  const posed = new Map<string, ProjectCaps | null>();
  const lastEvents = new Map<string, MemoryEvents>();
  const throttledUntil = new Map<string, number>();
  /** Événements de cwatch.slice au tick précédent : le plafond global qui freine compte son « high » sur elle seule. */
  let lastRootEvents: MemoryEvents | null = null;
  let rootThrottledUntil = -Infinity;
  /** Freinage de la dernière minute, par slice (cwatch.slice comprise) : voir recent.ts. */
  const recent = new Map<string, Recent>();
  const recentPct = (unit: string, s: CgroupStats, now: number): number | undefined => {
    let r = recent.get(unit);
    if (!r) recent.set(unit, (r = createRecent()));
    r.push({ at: now, high: s.events.high, stallUs: s.stallUs ?? null });
    return r.pct();
  };
  /** Slices de projet inconnues de systemd (« no-unit ») : leur budget repasse par ensureProjectSlice. */
  const lost = new Set<string>();
  /** Budget en échec : pas de nouvel essai avant cette heure (horloge monotone). */
  const retryAt = new Map<string, number>();
  const cgCache = new Map<string, { cg: string | null; at: number }>();
  const workMemo = deps.workMemo ?? new Map<string, boolean>();
  /** Slices inconnues ouvertes par `computer-watcher run` dont la racine n'a pas été trouvée : pas de nouvel essai avant. */
  const runTried = new Map<string, number>();
  let inFlight: Promise<void> | null = null;
  let lastError: string | null = null;
  let tickMs = 0;
  let seq = 0;
  let youngSeen = false;
  let st: AntigelState = {
    version: 1, at: 0, enabled: true, status: 'unavailable', reason: 'démarrage', memTotalKB: 0, reserveKB: null, slice: null,
    projects: [], slices: {}, lastError: null, tickMs: 0, dbusCalls: 0,
  };

  const attribute = (slice: string, root: string | null): void => {
    if (!plausible(slice, root) || slices.has(slice)) return;
    for (const r of slices.values()) if (r === root) return;
    slices.set(slice, root);
  };
  for (const [s, r] of Object.entries(deps.initialSlices ?? {})) attribute(s, r);

  const forget = (slice: string) => {
    slices.delete(slice);
    ensured.delete(slice);
    posed.delete(slice);
    lastEvents.delete(slice);
    throttledUntil.delete(slice);
    lost.delete(slice);
    retryAt.delete(slice);
    recent.delete(slice);
  };

  /** `<n>` d'un scope neuf : base 36 de l'horloge murale (8 chiffres) + compteur (4 chiffres), [a-z0-9]{12}. */
  const nextN = (ts: number): string => {
    const t = Math.floor(ts);
    const clock = Number.isSafeInteger(t) && t > 0 ? t.toString(36).slice(-8).padStart(8, '0') : '00000000';
    const n = (seq++ % 36 ** 4).toString(36).padStart(4, '0');
    return clock + n;
  };

  const report = (msg: string) => {
    if (msg !== lastError) deps.log(`anti-gel: ${msg}`);
    lastError = msg;
  };
  /** cwatch.slice en échec dans cet enchaînement (aussi quand elle est assurée depuis l'étape d'un projet) : arrêt. */
  let rootFailed = false;
  const run = (steps: Step[]) => {
    if (!steps.length) return;
    let failed = false;
    rootFailed = false;
    inFlight = (async () => {
      for (const s of steps) {
        try {
          await s.run();
        } catch (e) {
          failed = true;
          const code = e instanceof BusctlError ? e.code : 'other';
          const msg = e instanceof Error ? e.message : String(e);
          if (code === 'denied' || code === 'unreachable' || code === 'timeout') {
            avail = { ok: false, reason: `gestionnaire systemd injoignable : ${msg}` };
            probedAt = deps.monoNow();
            applied = null;
            ensured.clear();
            posed.clear();
            report(msg);
            return;
          }
          report(msg);
          if (s.critical || rootFailed) return;
        }
      }
    })()
      .then(() => {
        if (failed) return;
        if (lastError !== null) deps.log('anti-gel: appels systemd rétablis');
        lastError = null;
      })
      .finally(() => {
        inFlight = null;
      });
  };

  /**
   * Plafonds à poser sur une slice de projet pour ce budget (null : aucun) : ceux du budget, avec MemoryMax en convergence,
   * jamais sous l'usage actuel + marge (voir convergingMax : poser memory.max sous memory.current ferait tuer aussitôt).
   * MemoryMax en place : ce que ce processus a posé, sinon (redémarrage) ce que montre sysfs. Slice absente : usage nul.
   */
  const capsToPose = (slice: string, budget: ProjectCaps | null, s: CgroupStats | undefined): ProjectCaps | null => {
    if (budget === null) return null;
    const applied = posed.has(slice) ? (posed.get(slice)?.maxBytes ?? null) : (s?.maxBytes ?? null);
    return { ...budget, maxBytes: convergingMax(budget, s?.currentBytes ?? 0, applied) };
  };
  /** Plafonds d'une slice de projet à poser ? Ce que ce processus a posé fait foi ; sinon (redémarrage) ce que montre sysfs. */
  const needsCaps = (slice: string, want: ProjectCaps | null, s: CgroupStats) => {
    if (posed.has(slice)) return !sameCaps(posed.get(slice) ?? null, want);
    return want === null
      ? s.highBytes !== null || s.maxBytes !== null || s.swapMaxBytes !== null
      : s.highBytes !== want.highBytes || s.maxBytes !== want.maxBytes || s.swapMaxBytes !== want.swapMaxBytes;
  };
  /**
   * Plafonds d'une slice de projet. Après un « no-unit » (systemd ne connaît plus la slice), repassage par
   * ensureProjectSlice ; après un autre échec, recul de BUDGET_RETRY_MS (voir `budgetDue`).
   */
  const setCaps = (slice: string, want: ProjectCaps | null): Step => ({
    run: async () => {
      try {
        if (lost.has(slice)) {
          await client.ensureProjectSlice(slice, want);
          ensured.add(slice);
          lost.delete(slice);
        } else await client.setProjectCaps(slice, want);
      } catch (e) {
        if (e instanceof BusctlError && e.code === 'no-unit') {
          ensured.delete(slice);
          posed.delete(slice);
          lost.add(slice);
        } else retryAt.set(slice, deps.monoNow() + BUDGET_RETRY_MS);
        throw e;
      }
      posed.set(slice, want);
      retryAt.delete(slice);
    },
  });
  const budgetDue = (slice: string, now: number) => (retryAt.get(slice) ?? -Infinity) <= now;

  const step = (i: AntigelTickInput): AntigelOom[] => {
    const now = deps.monoNow();
    youngSeen = false;
    const base = { version: 1 as const, at: i.ts, enabled: i.config.enabled, memTotalKB: i.system.memTotalKB };
    if (avail === null || (!avail.ok && now - probedAt >= PROBE_EVERY_MS)) {
      avail = deps.probe();
      probedAt = now;
    }
    if (!avail.ok) {
      st = { ...st, ...base, status: 'unavailable', reason: avail.reason, reserveKB: null, slice: null, projects: [] };
      return [];
    }
    const userBase = avail.userBase;
    const cgOfSlice = (s: string) => `${userBase}/${slicePath(s)}`;
    const rootStats = deps.stats(cgOfSlice(ROOT_SLICE));
    const fixed = i.config.enabled ? sliceLimits(i.system.memTotalKB, i.system.swapTotalKB, i.config.reserveMB) : null;
    // MemoryHigh dynamique (travail + ce que le reste laisse au-dessus de la réserve), avec hystérésis contre `applied` ;
    // MemoryMax et MemorySwapMax restent statiques (voir dynamicLimits).
    const availKB = i.system.memAvailableKnown === false ? null : i.system.memAvailableKB;
    const limits = fixed && dynamicLimits(fixed, { workBytes: rootStats?.currentBytes ?? 0, availKB }, applied);
    const active = limits !== null;

    // Décision (pure) ; cgroups mis en cache par pid:startTicks (60 s). Éteint, elle sert seulement à retrouver les
    // slices de projet déjà peuplées (budgets à retirer) : aucun déplacement.
    const byPid = new Map(i.procs.map((p) => [p.pid, p]));
    // caches élagués chacun sur son propre seuil (workMemo grossit avec chaque commande vue sous une ancre, cgCache non)
    const cacheMax = 4 * i.procs.length + 100;
    if (cgCache.size > cacheMax || workMemo.size > cacheMax) {
      const alive = new Set(i.procs.map((p) => `${p.pid}:${p.startTicks}`));
      if (cgCache.size > cacheMax) for (const k of cgCache.keys()) if (!alive.has(k)) cgCache.delete(k);
      if (workMemo.size > cacheMax) for (const k of workMemo.keys()) if (!alive.has(k)) workMemo.delete(k);
    }
    const cgroupOf = (pid: number): string | null => {
      const key = `${pid}:${byPid.get(pid)?.startTicks ?? -1}`;
      const hit = cgCache.get(key);
      if (hit && now >= hit.at && now - hit.at < CGROUP_MAX_AGE_MS) return hit.cg;
      const cg = deps.cgroupOf(pid);
      cgCache.set(key, { cg, at: now });
      return cg;
    };
    const projectOf = projectsByPid(i.groups, i.home);
    const plan = planMoves({
      procs: i.procs, projectOf: (pid) => projectOf.get(pid) ?? null, currentUid: i.currentUid, selfPid: i.selfPid, appRoot: i.appRoot,
      isProtected: i.isProtected, cgroupOf, userBase, claudeDirs: i.claudeDirs, workMemo,
    });
    // Bureau prioritaire (lot 2) : seulement sous un plafond actif ; éteint, valeurs d'origine restaurées.
    // (une erreur du bureau prioritaire ne casse jamais le plafond de travail)
    try {
      desk?.tick({
        on: active && i.config.desk !== false, userBase, procs: i.procs, uid: i.currentUid, cgroupOf,
        reserveBytes: limits?.reserveBytes ?? null, rootExists: rootStats !== null,
      });
    } catch (e) {
      deps.log(`anti-gel (bureau prioritaire) : ${e instanceof Error ? e.message : String(e)}`);
    }

    // Attribution reconstruite depuis les processus déjà rangés : segment cwatch-p-<clé>.slice de leur cgroup.
    const sliceRoot = `${userBase}/${ROOT_SLICE}/cwatch-p.slice/`;
    const projectSliceOf = (cg: string): string | null => {
      if (!cg.startsWith(sliceRoot)) return null;
      const seg = cg.slice(sliceRoot.length).split('/', 1)[0]!;
      return isProdProjectSliceName(seg) && cg.startsWith(`${cgOfSlice(seg)}/`) ? seg : null;
    };
    const insideBySlice = new Map<string, number[]>();
    for (const x of plan.inside) {
      const s = projectSliceOf(x.cgroup);
      if (!s) continue;
      attribute(s, x.root);
      insideBySlice.set(s, [...(insideBySlice.get(s) ?? []), x.pid]);
    }
    // Slices ouvertes par `computer-watcher run` (lot 4) et inconnues : attribuées d'après le dossier courant de leurs
    // processus, seulement si c'est le nom haché de cette racine (run n'ouvre jamais un nom simple non attribué) ;
    // jamais redéplacées (elles sont sous cwatch).
    if (deps.run) {
      const run = deps.run;
      if (runTried.size > MAX_UNITS) runTried.clear();
      for (const name of (run.listDir(`${userBase}/${ROOT_SLICE}/cwatch-p.slice`) ?? []).slice(0, MAX_UNITS)) {
        if (!isProdProjectSliceName(name) || slices.has(name) || (runTried.get(name) ?? -Infinity) > now) continue;
        const r = runSliceRoot(name, cgOfSlice(name), run, byPid, i.projectRootOf, i.home, (s, root) => s === hashedProjectSlice(root));
        if (r === 'pending') continue; // revue au tick suivant, sans recul
        if (r !== 'none') attribute(name, r.root);
        if (!slices.has(name)) runTried.set(name, now + RUN_RETRY_MS);
      }
    }
    // Slices de projet connues : statistiques ; une slice disparue que ce processus n'a pas assurée est oubliée.
    const sliceStats = new Map<string, CgroupStats>();
    for (const s of [...slices.keys()]) {
      const v = deps.stats(cgOfSlice(s));
      if (v) sliceStats.set(s, v);
      else if (!ensured.has(s)) forget(s);
    }

    if (!active) {
      // Éteint, ou réserve trop grande (aucun plafond global : ne rien déplacer est le choix sûr). Plafonds de cwatch.slice
      // et budgets remis à infinity une seule fois (aussi après un redémarrage du service) ; aucun StopUnit, aucun
      // processus ressorti.
      lastEvents.clear();
      throttledUntil.clear();
      lastRootEvents = null;
      rootThrottledUntil = -Infinity;
      recent.clear();
      if (!inFlight) {
        const steps: Step[] = [];
        if (applied !== null || (!rootReset && capped(rootStats))) {
          steps.push({
            critical: true,
            run: async () => {
              await client.setSlice(ROOT_SLICE, null);
              applied = null;
              rootReset = true;
            },
          });
        }
        for (const [s, v] of sliceStats) if (needsCaps(s, null, v) && budgetDue(s, now)) steps.push(setCaps(s, null));
        run(steps);
      }
      const reason = i.config.enabled ? RESERVE_TOO_BIG : null;
      st = {
        ...st, ...base, status: i.config.enabled ? 'unavailable' : 'off', reason, reserveKB: null,
        slice: rootStats && toSlice(rootStats), projects: [],
      };
      return [];
    }

    // Processus déjà rangés, par slice : les racines retrouvées et leurs descendants encore dans cette slice.
    const children = new Map<number, number[]>();
    for (const p of i.procs) {
      if (p.ppid === p.pid) continue;
      const l = children.get(p.ppid);
      if (l) l.push(p.pid);
      else children.set(p.ppid, [p.pid]);
    }
    /** Processus rangés dans la slice et leur mémoire anonyme (RssAnon : ce que le cgroup qui l'a allouée compte). */
    const procsIn = (s: string): { n: number; anonKB: number } => {
      const prefix = `${cgOfSlice(s)}/`;
      // processus des scopes « run » (lot 4) : comptés par cgroup.procs, une seule fois
      const run = deps.run ? runPidsOf(cgOfSlice(s), deps.run) : new Set<number>();
      const seen = new Set<number>(run);
      const stack = [...(insideBySlice.get(s) ?? [])];
      let n = 0;
      let anonKB = 0;
      for (const pid of run) anonKB += byPid.get(pid)?.anonKB ?? 0;
      while (stack.length) {
        const pid = stack.pop()!;
        if (seen.has(pid)) continue;
        seen.add(pid);
        if (cgroupOf(pid)?.startsWith(prefix)) {
          n++;
          anonKB += byPid.get(pid)?.anonKB ?? 0;
        }
        stack.push(...(children.get(pid) ?? []));
      }
      return { n: n + run.size, anonKB };
    };

    // Ralentissement par le plafond global : le noyau compte « high » sur cwatch.slice elle-même (le cgroup dont la limite
    // est dépassée), jamais sur ses enfants. Tous les projets peuplés sont alors ralentis.
    if (rootStats) {
      if (lastRootEvents && rootStats.events.high > lastRootEvents.high) rootThrottledUntil = now + THROTTLE_HOLD_MS;
      lastRootEvents = rootStats.events;
    } else lastRootEvents = null;
    const rootThrottled = rootThrottledUntil > now;
    const rootPct = rootStats ? recentPct(ROOT_SLICE, rootStats, now) : undefined;
    if (!rootStats) recent.delete(ROOT_SLICE);

    // OOM et ralentissements par le budget, lus sur la slice du projet (memory.events, hiérarchique : ses scopes compris).
    // Une slice vide (plus aucun processus) reste suivie (budget, OOM, extinction) mais n'est pas publiée : ni badge ni compte.
    // Budget effectif : explicite, sinon budget par défaut (sauf projet « sans budget ») ; hors projet : aucun.
    const budgetOf = (root: string | null): number | null => effectiveBudget(i.config, root)?.mb ?? null;
    const ooms: AntigelOom[] = [];
    const projects: AntigelProjectState[] = [];
    for (const [unit, root] of slices) {
      const s = sliceStats.get(unit);
      if (!s) continue;
      const prev = lastEvents.get(unit);
      if (prev && s.events.high > prev.high) throttledUntil.set(unit, now + THROTTLE_HOLD_MS);
      if (prev && s.events.oomKill > prev.oomKill) {
        ooms.push({ unit, root, kills: s.events.oomKill - prev.oomKill, ...(s.events.oom > prev.oom ? { budget: true } : {}) });
      }
      lastEvents.set(unit, s.events);
      const pct = recentPct(unit, s, now);
      if (s.populated && projects.length < MAX_UNITS) {
        const inside = procsIn(unit);
        const outside = outsideKB(inside.anonKB, kb(s.currentBytes));
        const own = (throttledUntil.get(unit) ?? -Infinity) > now;
        projects.push({
          unit, root, procs: inside.n, currentKB: kb(s.currentBytes), budgetMB: budgetOf(root),
          ...(effectiveBudget(i.config, root)?.source === 'default' ? { budgetDefault: true } : {}),
          throttled: rootThrottled || own, budgetThrottled: own,
          ...(outside !== undefined ? { outsideKB: outside } : {}),
          ...(pct !== undefined ? { stallPct: pct } : {}),
          ...(s.maxBytes !== null ? { maxKB: kb(s.maxBytes) } : {}),
        });
      }
    }

    st = {
      ...st, ...base, status: 'active', reason: null, reserveKB: kb(limits.reserveBytes), projects,
      slice: rootStats && { ...toSlice(rootStats), throttled: rootThrottled, ...(rootPct !== undefined ? { stallPct: rootPct } : {}) },
    };
    youngSeen = plan.refused.some((r) => r.reason === 'young');
    if (inFlight) return ooms;

    /** Plafonds du budget d'une racine (budget, part de swap, plafond dur) ; null : aucun budget. */
    const budgetCaps = (root: string | null): ProjectCaps | null => {
      const mb = budgetOf(root);
      return mb === null ? null : projectCaps(mb);
    };
    /** Plafonds à poser par slice ce tick-ci (convergence comprise), aussi pour une slice assurée par un déplacement. */
    const toPose = (s: string): ProjectCaps | null => capsToPose(s, budgetCaps(slices.get(s) ?? null), sliceStats.get(s));
    const steps: Step[] = [];
    // cwatch.slice en place avec nos plafonds : sinon (premier tick, plafonds changés, slice disparue) assurée d'abord.
    let rootReady = sameLimits(applied, limits) && rootStats !== null;
    const ensureRoot = async () => {
      try {
        if (applied === null || rootStats === null) await client.ensureSlice(ROOT_SLICE, limits);
        else await client.setSlice(ROOT_SLICE, limits);
      } catch (e) {
        rootFailed = true;
        throw e;
      }
      applied = limits;
      rootReset = false;
      rootReady = true;
    };
    if (!sameLimits(applied, limits)) steps.push({ critical: true, run: ensureRoot });
    // Plafonds des slices existantes : un appel par changement (recul après un échec), plafond dur en convergence. Slice au
    // frigo : rien (le frigo a levé sa part de swap) ; ce qui y était posé est oublié, et sysfs fait foi au réveil.
    for (const [s, v] of sliceStats) {
      if (i.frozenSlices?.has(s)) {
        posed.delete(s);
        continue;
      }
      const w = toPose(s);
      if (needsCaps(s, w, v) && budgetDue(s, now)) steps.push(setCaps(s, w));
    }

    // Déplacements regroupés par slice de projet : un seul scope neuf par projet et par tick.
    const bySlice = new Map<string, PlanMove[]>();
    /** Le cgroup de cette slice existe-t-il déjà (sysfs) ? */
    const present = (s: string) => sliceStats.has(s) || deps.stats(cgOfSlice(s)) !== null;
    for (const m of plan.moves) {
      let s = projectSliceFor(m.root, slices);
      if (m.root !== null && !slices.has(s) && present(s)) {
        // slice déjà là sans attribution dans ce processus (état perdu, processus d'une autre racine hors de toute ancre) :
        // considérée comme prise, jamais réattribuée ; nom haché, et s'il existe aussi, pas de déplacement
        s = projectSliceFor(m.root, new Map([...slices, [s, null]]));
        if (!slices.has(s) && present(s)) continue;
      }
      if (slices.has(s) && slices.get(s) !== m.root) continue; // collision de hachage : jamais la slice d'une autre racine
      if (i.frozenSlices?.has(s)) continue; // projet au frigo : ses nouveaux processus restent où ils sont jusqu'au réveil
      slices.set(s, m.root);
      bySlice.set(s, [...(bySlice.get(s) ?? []), m]);
    }
    for (const [s, moves] of bySlice) {
      const w = toPose(s);
      const exists = sliceStats.has(s);
      steps.push({ run: async () => {
        // rien de vivant : aucun appel (ni slice de projet, ni scope)
        if (moves.every((m) => deps.reverify(m.targets, m.anchorCgroup).length === 0)) return;
        if (!rootReady) await ensureRoot();
        if (!ensured.has(s) || !exists || lost.has(s)) {
          await client.ensureProjectSlice(s, w);
          ensured.add(s);
          lost.delete(s);
          posed.set(s, w);
          retryAt.delete(s);
        }
        // Revérification juste avant l'appel. Au-delà de MAX_PIDS, la racine d'un sous-arbre coupé reste dehors : elle
        // reste racine au tick suivant, et le reste de son sous-arbre (encore dans l'unité de l'ancre) suit avec elle.
        const batch = new Map<number, PlanTarget>();
        for (const m of moves) {
          const live = deps.reverify(m.targets, m.anchorCgroup).filter((t) => !batch.has(t.pid));
          if (!live.length) continue;
          const room = MAX_PIDS - batch.size;
          if (live.length <= room) for (const t of live) batch.set(t.pid, t);
          else {
            for (const t of live.filter((x) => x.pid !== m.rootPid).slice(0, room)) batch.set(t.pid, t);
            break;
          }
        }
        if (!batch.size) return;
        await client.startScope(newScopeName(s, nextN(i.ts)), s, [...batch.keys()]);
        for (const t of batch.values()) cgCache.delete(`${t.pid}:${t.startTicks}`);
      } });
    }
    run(steps);
    return ooms;
  };

  const slicesOut = () => Object.fromEntries([...slices].slice(0, MAX_UNITS));
  return {
    tick(i) {
      const t0 = perfNow();
      try {
        return step(i);
      } finally {
        const ms = Math.max(0, perfNow() - t0);
        tickMs = tickMs === 0 ? ms : tickMs * 0.9 + ms * 0.1;
        st = { ...st, slices: slicesOut(), lastError, tickMs: Math.round(tickMs * 100) / 100, dbusCalls: dbusCalls(), ...(desk ? { desk: desk.state() } : {}) };
      }
    },
    // Champs vivants (fin de l'enchaînement en vol comprise) : erreur, attribution, nombre d'appels.
    state: () => ({ ...st, slices: slicesOut(), lastError, dbusCalls: dbusCalls(), ...(desk ? { desk: desk.state() } : {}) }),
    async idle() {
      while (inFlight) await inFlight;
      await desk?.idle();
    },
    recheckMs: () => (youngSeen ? RECHECK_YOUNG_MS : null),
  };
}
