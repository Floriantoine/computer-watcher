// src/recorder/recorder.ts
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, homedir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { appFocused, desktopMessage, desktopAllowed, parseFocusState, type AlertEvent, type AlertsConfig } from '../core/alerts';
import { classifyGroups, type InstanceDecision } from '../core/classify/classify';
import { readPackageHints } from '../core/classify/packageJson';
import { CpuTracker } from '../core/collector/cpuTracker';
import { readListeningPorts } from '../core/collector/ports';
import { readProcesses } from '../core/collector/readProcesses';
import { readSystem } from '../core/collector/readSystem';
import { loadConfig } from '../core/config';
import { buildGroups } from '../core/grouping/buildGroups';
import { claudeDirs } from '../core/grouping/claudeDirs';
import { createProjectRootCache } from '../core/grouping/projectRootCache';
import { DEV_TOOL } from '../core/grouping/rules';
import { readEarlyoomThresholds } from '../core/forecast/earlyoom';
import { MarginBuffer, SNOOZE_MS, alertText, conditionHeld, forecast, stepAlert, type AlertState, type Forecast } from '../core/forecast/forecast';
import { readSnooze, writeSnooze } from '../core/forecast/snooze';
import { historyBackups, openHistoryDb } from '../core/history/db';
import {
  detectGap, insertEvent, lastEventTs, lastSampleTs, parseEarlyoom, parseJournalLine, ruleEventsSince, shouldRecordPressure, shouldRecordTmpfs, takeAppEvents,
  type TmpfsAlertState,
} from '../core/history/events';
import { historyCovers, queryCulprits, queryInactive } from '../core/history/queries';
import type { KillFn } from '../core/kill';
import { compileProtection, type Protection } from '../core/protection';
import { emptyRuleState, evaluateRules, needsClassification, restoreRuleState, type RuleState } from '../core/rules/engine';
import type { RulesConfig } from '../core/rules/types';
import type { Group } from '../core/types';
import { flattenGroup } from '../core/snapshot';
import { aggregateHour, aggregateMinute, clearAll, leakCandidates, purge } from '../core/history/maintenance';
import { HistoryWriter } from '../core/history/writer';
import { appEventsPath, clearRequestPath, dbPath, focusStatePath, forecastSnoozePath, statusPath } from '../core/paths';
import type { RecorderConfig, RecorderStatus, SystemInfo } from '../core/types';
import type { Notifier } from './notify';
import { createRuleRunner } from './ruleRunner';

export interface RecorderDeps {
  dataDir: string;
  configDir: string;
  procRoot?: string;
  now?: () => number;
  cpuCount?: number;
  log?: (msg: string) => void;
  /** Notifications du bureau (absent : aucune). */
  notifier?: Notifier;
  /** Lance ou réveille l'app avec ces arguments (bouton « Ouvrir ») ; absent : notifications sans bouton. */
  launchApp?: (args: string[]) => void;
  /** Fichier d'état de focus de l'app (défaut : focusStatePath). */
  focusFile?: string;
  /** Seuils d'earlyoom pour la prévision (défaut : /etc/default/earlyoom). */
  earlyoomFile?: string;
  /**
   * Signal des règles actives. Absent : aucun signal possible (chaque envoi échoue en NOKILL). Le service réel passe
   * serviceKill() ; les tests un espion.
   */
  kill?: KillFn;
  /** Pid du service (défaut : process.pid) : lui et ses ancêtres ne sont jamais visés. */
  selfPid?: number;
  /** Uid courant (défaut : process.getuid()). */
  currentUid?: number;
  /** Dossier de l'app proc-watch, jamais visée (défaut : null). */
  appRoot?: string | null;
  /** Minuterie de l'escalade SIGTERM → SIGKILL (défaut : setTimeout). */
  ruleTimers?: { setTimeout(fn: () => void, ms: number): unknown };
}

export interface Recorder {
  start(): void;
  tick(): void;
  minuteJob(): void;
  reloadConfig(): void;
  setEarlyoomSource(s: 'ok' | 'unavailable'): void;
  onEarlyoomLine(line: string): void;
  stop(): void;
  status(): RecorderStatus;
  config(): RecorderConfig;
  /**
   * Notification du bureau pour une alerte déjà enregistrée (id = id de l'événement) : selon son canal, sauf si l'app est
   * au premier plan, au plus une par type par `desktopMinIntervalMin`. Ne bloque jamais (promesse non attendue).
   * Point d'entrée de la prévision ② : insérer l'événement `forecast`, puis appeler `notifyAlert`.
   */
  notifyAlert(e: AlertEvent): void;
  /** Dernière prévision d'épuisement de la mémoire (null : pas assez d'échantillons). */
  forecast(): Forecast | null;
  /** Compteurs des règles (tests, mesures) : classements faits pour les règles, évaluations. */
  stats(): { classifyRuns: number; ruleEvaluations: number };
}

const M = 60_000;
const H = 3600_000;
/** Le nettoyage des processus/groupes orphelins (parcours complet) ne tourne qu'une minute sur 10. */
const ORPHANS_EVERY = 10;
/** Au-delà, une alerte n'est plus envoyée sur le bureau (rattrapage). */
const MAX_DESKTOP_AGE_MS = 5 * M;
/** Seuils d'earlyoom relus toutes les 10 min (Réglages › earlyoom peut les changer). */
const THRESHOLDS_EVERY_MS = 10 * M;
/** Écriture d'une alerte de prévision en échec : nouvel essai après 10 s, puis 20 s, 40 s… jusqu'à 5 min. */
const RETRY_FIRST_MS = 10_000;
const RETRY_MAX_MS = 5 * M;
/** Sans prévision plus de 6 min après le démarrage : « indisponible » (moins de 5 échantillons en 5 min). */
const FORECAST_WARMUP_MS = 6 * M;
/** Règles : ports en écoute relus au plus toutes les 60 s (classement des instances). */
const RULE_PORTS_EVERY_MS = 60_000;
/** Règles : cache des décisions de classement vidé toutes les 60 s (durée du cache de package.json). */
const RULE_DECISIONS_MAX_AGE_MS = 60_000;

export function createRecorder(deps: RecorderDeps): Recorder {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.error(m));
  const procRoot = deps.procRoot ?? '/proc';
  const ncpu = deps.cpuCount ?? Math.max(1, cpus().length);
  const tracker = new CpuTracker();
  const cmdlineCache = new Map<string, string>();
  const projectRootOf = createProjectRootCache();
  const wantCwd = (name: string) => DEV_TOOL.test(name);
  // Outils Claude détachés : rangés dans Claude (seuls les outils de dev ont leur dossier de travail lu ici).
  const claudeConfigDirs = claudeDirs();
  const loadedInitial = loadConfig(deps.configDir);
  const initial = loadedInitial.config;
  let cfg: RecorderConfig = initial.recorder;
  let alertsCfg: AlertsConfig = initial.alerts;
  let rulesCfg: RulesConfig = initial.rules;
  let overrides = initial.classify.overrides;
  let detectPorts = initial.classify.detectPorts;
  let protection: Protection = compileProtection(initial.protected);
  /** Journalisées une fois par changement (la config est relue à chaque écriture du fichier). */
  let lastIssues = '';
  const logRuleIssues = (issues: { index: number; name: string | null; error: string }[] | undefined) => {
    const key = JSON.stringify(issues ?? []);
    if (key === lastIssues) return;
    lastIssues = key;
    for (const i of issues ?? []) log(`règles: règle ${i.name ? `« ${i.name} »` : `n° ${i.index + 1}`} ignorée : ${i.error}`);
  };
  logRuleIssues(loadedInitial.ruleIssues);
  /** Dernière notification du bureau par type (anti-spam). */
  const lastDesktop = new Map<string, number>();
  let db: DatabaseSync | null = null;
  let writer: HistoryWriter | null = null;
  let lastMinute = 0;
  /** Première heure pas encore close dans les tables horaires. */
  let lastHour = 0;
  let purges = 0;
  const st: RecorderStatus = { pid: process.pid, startedAt: now(), lastSampleAt: null, lastError: null, earlyoomSource: 'unavailable', dbSizeBytes: 0, warning: null };

  type Job = 'tick' | 'minute' | 'earlyoom' | 'rules';
  const jobErrors: Record<Job, string | null> = { tick: null, minute: null, earlyoom: null, rules: null };
  const errorAt: Record<Job, number> = { tick: 0, minute: 0, earlyoom: 0, rules: 0 };
  let errSeq = 0;
  st.jobErrors = jobErrors;
  let lastPressureTs: number | null = null;
  let tmpfs: TmpfsAlertState = { lastTs: null, armed: false, belowSince: null };
  // Prévision ② : marge glissante sur 6 min, seuils d'earlyoom, anti-répétition (30 min) et « Ignorer 30 min ».
  const margins = new MarginBuffer();
  let thresholds = readEarlyoomThresholds(deps.earlyoomFile);
  let thresholdsAt = now();
  let lastForecast: Forecast | null = null;
  let forecastState: AlertState = { lastAlertAt: null, snoozedUntil: null, holdingSince: null };
  /** Échec durable de l'écriture de l'alerte : délai courant (0 : pas d'échec), prochain essai, dernier message journalisé. */
  let retryMs = 0;
  let retryAt = 0;
  const snoozeFile = () => forecastSnoozePath(deps.dataDir);

  const writeStatus = () => {
    try {
      const size = (p: string) => (existsSync(p) ? statSync(p).size : 0);
      st.dbSizeBytes = size(dbPath(deps.dataDir)) + size(`${dbPath(deps.dataDir)}-wal`);
      const tmp = `${statusPath(deps.dataDir)}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(st), { mode: 0o600 });
      renameSync(tmp, statusPath(deps.dataDir));
    } catch (e) {
      log(`status: ${(e as Error).message}`);
    }
  };

  /** lastError = erreur non nulle la plus récente ; chaque travail n'efface que la sienne. */
  const refreshLastError = () => {
    let best: Job | null = null;
    for (const j of ['tick', 'minute', 'earlyoom', 'rules'] as Job[]) if (jobErrors[j] && (!best || errorAt[j] > errorAt[best])) best = j;
    st.lastError = best ? jobErrors[best] : null;
  };
  const ok = (job: Job) => {
    jobErrors[job] = null;
    refreshLastError();
  };
  const fail = (job: Job, where: string, e: unknown) => {
    jobErrors[job] = `${where}: ${(e as Error).message ?? String(e)}`;
    errorAt[job] = ++errSeq;
    refreshLastError();
    log(jobErrors[job]!);
    writeStatus();
  };

  const readFocus = () => {
    try {
      return parseFocusState(readFileSync(deps.focusFile ?? focusStatePath(deps.dataDir), 'utf8'));
    } catch {
      return null;
    }
  };

  /** `always` : sans l'anti-spam par type (une notification à chaque action d'une règle). */
  const notifyAlert = (e: AlertEvent, always = false): void => {
    const notifier = deps.notifier;
    if (!notifier) return;
    try {
      if (alertsCfg.channels[e.type] !== 'both') return;
      const t = now();
      // ligne de journal rattrapée en retard : l'alerte reste dans l'app (pop-up), pas sur le bureau
      if (t - e.ts > MAX_DESKTOP_AGE_MS) return;
      if (appFocused(readFocus(), t)) return; // l'app au premier plan montre déjà le pop-up
      if (!always && !desktopAllowed(lastDesktop, e.type, t, alertsCfg.desktopMinIntervalMin)) return;
      lastDesktop.set(e.type, t);
      const launch = deps.launchApp;
      const { title, body } = desktopMessage(e);
      // Prévision : « Libérer… » ouvre l'app sur l'alerte (kill groupé pré-rempli, rien sans confirmation) ; « Ignorer 30 min ».
      const actions = e.type === 'forecast'
        ? [...(launch ? [{ id: 'free', label: 'Libérer…' }] : []), { id: 'snooze', label: 'Ignorer 30 min' }]
        : launch ? [{ id: 'open', label: 'Ouvrir' }] : [];
      notifier
        .notify({ title, body, urgency: 'critical', actions })
        .then(
          (choice) => {
            if (choice === 'open' || choice === 'free') launch?.([`--alert=${e.id}`]);
            else if (choice === 'snooze') snooze(now() + SNOOZE_MS);
          },
          (err: unknown) => log(`notification: ${(err as Error)?.message ?? String(err)}`),
        );
    } catch (err) {
      log(`notification: ${(err as Error).message}`);
    }
  };
  const alert = (id: number, ts: number, type: AlertEvent['type'], groupKey: string | null, groupLabel: string | null, detail: Record<string, unknown>) =>
    notifyAlert({ id, ts, type, groupKey, groupLabel, detail });

  /** « Ignorer 30 min » : retenu en mémoire et dans le fichier d'état (survit à un redémarrage du service). */
  const snooze = (until: number) => {
    forecastState = { ...forecastState, snoozedUntil: Math.max(forecastState.snoozedUntil ?? 0, until) };
    try {
      writeSnooze(snoozeFile(), forecastState.snoozedUntil!, now());
    } catch (e) {
      log(`prévision: « Ignorer » non enregistré : ${(e as Error).message}`);
    }
  };

  /** Prévision après l'écriture du tick ; une erreur ici ne fait pas échouer le tick. */
  const runForecast = (d: DatabaseSync, ts: number, system: SystemInfo) => {
    try {
      margins.push({ ts, memAvailableKB: system.memAvailableKB, swapFreeKB: system.swapFreeKB, memTotalKB: system.memTotalKB, swapTotalKB: system.swapTotalKB });
      const f = forecast(margins.samples(), thresholds, ts);
      lastForecast = f;
      st.forecast = f ? 'ok' : ts - st.startedAt < FORECAST_WARMUP_MS ? 'warming' : 'unavailable';
      const r = stepAlert(f, forecastState, ts);
      if (!r.alert) {
        forecastState = r.state;
        return;
      }
      // pas d'alerte : la condition reste « tenue » (holdingSince), lastAlertAt inchangé
      const holding = { ...forecastState, holdingSince: r.state.holdingSince };
      // « Ignorer 30 min » cliqué dans le pop-up de l'app (fichier écrit par le main)
      const fileSnooze = readSnooze(snoozeFile(), ts);
      if (fileSnooze !== null && ts < fileSnooze) {
        forecastState = { ...holding, snoozedUntil: Math.max(holding.snoozedUntil ?? 0, fileSnooze) };
        return;
      }
      if (ts < retryAt) {
        forecastState = holding;
        return;
      }
      let id: number;
      let detail: Record<string, unknown>;
      try {
        const top = queryCulprits(d, ts, { now: ts, detailHours: cfg.detailHours, intervalSec: cfg.intervalSec }, 5, 5)
          .filter((c) => c.deltaKB > 0)
          .slice(0, 2)
          .map((c) => ({ key: c.key, label: c.label, deltaKB: c.deltaKB }));
        const swapPct = system.swapTotalKB > 0 ? (100 * (system.swapTotalKB - system.swapFreeKB)) / system.swapTotalKB : null;
        const { body } = alertText(f!, top, swapPct);
        detail = {
          etaMin: Math.round(f!.etaMin! * 10) / 10, marginKB: Math.round(f!.marginKB), slopeKBPerMin: Math.round(f!.slopeKBPerMin),
          decliningMinutes: f!.decliningMinutes, top, body,
        };
        id = insertEvent(d, ts, 'forecast', null, detail);
      } catch (e) {
        // base verrouillée ou pleine : nouvel essai espacé, une ligne de journal par changement de délai
        const next = retryMs ? Math.min(retryMs * 2, RETRY_MAX_MS) : RETRY_FIRST_MS;
        if (next !== retryMs) log(`prévision: alerte non enregistrée (${(e as Error).message}), nouvel essai dans ${Math.round(next / 1000)} s`);
        retryMs = next;
        retryAt = ts + retryMs;
        forecastState = holding;
        return;
      }
      if (retryMs) log("prévision: enregistrement des alertes rétabli");
      retryMs = 0;
      retryAt = 0;
      forecastState = r.state;
      alert(id, ts, 'forecast', null, null, detail);
    } catch (e) {
      log(`prévision: ${(e as Error).message}`);
    }
  };

  // Règles automatiques (⑥) : état (quotas, dépassements), classement à la demande, exécution.
  const selfPid = deps.selfPid ?? process.pid;
  const currentUid = deps.currentUid ?? process.getuid?.() ?? -1;
  const appRoot = deps.appRoot ?? null;
  let ruleState: RuleState = emptyRuleState();
  const counters = { classifyRuns: 0, ruleEvaluations: 0 };
  const decisions = new Map<string, InstanceDecision>();
  let decisionsAt = 0;
  let rulePorts = new Map<number, number[]>();
  let rulePortsAt = 0;
  const noKill: KillFn = (pid, signal) => {
    log(`règles: aucun kill injecté, ${signal} non envoyé au processus ${pid}`);
    throw Object.assign(new Error('kill absent'), { code: 'NOKILL' });
  };
  let runner: ReturnType<typeof createRuleRunner> | null = null;
  const ruleRunner = (d: DatabaseSync) =>
    (runner ??= createRuleRunner({
      db: d, kill: deps.kill ?? noKill, readProcs: () => readProcesses(procRoot, { cmdlineCache }), selfPid, currentUid, appRoot,
      isProtected: (name) => protection.isProtected(name),
      notify: (e) => notifyAlert(e, e.type === 'rule_action'),
      setTimeout: (fn, ms) => (deps.ruleTimers ?? { setTimeout: (f: () => void, t: number) => setTimeout(f, t) }).setTimeout(fn, ms),
      now, log,
    }));

  const classifyForRules = (groups: Group[], ts: number) => {
    counters.classifyRuns++;
    if (!(ts - decisionsAt >= 0 && ts - decisionsAt < RULE_DECISIONS_MAX_AGE_MS)) {
      decisions.clear();
      decisionsAt = ts;
    }
    if (!detectPorts) rulePorts = new Map();
    else if (!(ts - rulePortsAt >= 0 && ts - rulePortsAt < RULE_PORTS_EVERY_MS)) {
      rulePortsAt = ts;
      const pids = groups.filter((g) => g.kind === 'project' || g.kind === 'deleted').flatMap((g) => flattenGroup(g).map((p) => p.pid));
      rulePorts = pids.length ? readListeningPorts(pids, procRoot) : new Map();
      decisions.clear();
    }
    return classifyGroups(groups, { overrides, ports: rulePorts, pkg: (root) => readPackageHints(root), isProtected: protection.isProtected, memo: decisions });
  };

  /** Règles après l'écriture du tick, dans leur propre try : une erreur ici ne casse jamais l'échantillonnage. */
  const runRules = (d: DatabaseSync, ts: number, groups: Group[]) => {
    // interrupteur général éteint, ou aucune règle activée : rien (pas même de classement ni de simulation)
    if (!rulesCfg.enabled || !rulesCfg.list.some((r) => r.enabled)) return;
    try {
      counters.ruleEvaluations++;
      const classification = needsClassification(rulesCfg.list, rulesCfg.enabled) ? classifyForRules(groups, ts) : null;
      const wantsForecast = rulesCfg.list.some((r) => r.enabled && r.condition.kind === 'forecast');
      const fc = wantsForecast && lastForecast ? { forecast: lastForecast, held: conditionHeld(lastForecast, forecastState, ts) } : null;
      const opts = { now: ts, detailHours: cfg.detailHours, intervalSec: cfg.intervalSec };
      const growthKB = fc?.held ? new Map(queryCulprits(d, ts, opts, 5, 50).map((c) => [c.key, c.deltaKB])) : new Map<string, number>();
      const out = evaluateRules({
        now: ts, enabled: rulesCfg.enabled, rules: rulesCfg.list, groups, classification, forecast: fc, growthKB,
        // sans historique couvrant toute la période (service récent, trou d'enregistrement) : null, rien n'est « inactif »
        inactive: (targets, since) => (historyCovers(d, since, ts) ? queryInactive(d, targets, since, opts) : null),
        isProtected: protection.isProtected, appRoot, currentUid, selfPid,
      }, ruleState);
      ruleRunner(d).run(out);
      if (jobErrors.rules) ok('rules');
    } catch (e) {
      fail('rules', 'règles', e);
    }
  };

  return {
    config: () => cfg,
    notifyAlert: (e) => notifyAlert(e),
    forecast: () => lastForecast,
    status: () => ({ ...st }),
    stats: () => ({ ...counters }),

    start() {
      mkdirSync(deps.dataDir, { recursive: true, mode: 0o700 });
      let opened: ReturnType<typeof openHistoryDb>;
      try {
        opened = openHistoryDb(dbPath(deps.dataDir), { now });
      } catch (e) {
        if ((e as { code?: string }).code !== 'HISTORY_DB_NEWER') throw e;
        // base d'une version plus récente : on reste inactif (aucune écriture), sans planter en boucle
        jobErrors.tick = "Base d'historique créée par une version plus récente de proc-watch : enregistrement suspendu";
        errorAt.tick = ++errSeq;
        refreshLastError();
        log(jobErrors.tick);
        writeStatus();
        return;
      }
      db = opened.db;
      writer = new HistoryWriter(db);
      st.warning = opened.warning;
      if (opened.warning) log(opened.warning);
      if (opened.recreated) {
        insertEvent(db, now(), 'gap', null, { reason: 'base illisible, recréée', backup: opened.recreated });
      }
      const gap = detectGap(lastSampleTs(db), now(), cfg.intervalSec);
      if (gap) insertEvent(db, now(), 'gap', null, gap);
      const last = lastSampleTs(db);
      const current = Math.floor(now() / M) * M;
      // reprend à la minute du dernier échantillon (l'agrégation est idempotente) ; les échantillons plus vieux que detailHours sont déjà purgés
      lastMinute = last === null ? current : Math.max(Math.floor(last / M) * M, current - cfg.detailHours * 3600_000);
      lastHour = Math.floor(lastMinute / H) * H;
      lastPressureTs = lastEventTs(db, 'pressure');
      tmpfs = { lastTs: lastEventTs(db, 'tmpfs'), armed: false, belowSince: null };
      // pas de nouvelle alerte de prévision juste après un redémarrage du service
      forecastState = { lastAlertAt: lastEventTs(db, 'forecast'), snoozedUntil: readSnooze(snoozeFile(), now()), holdingSince: null };
      // quotas et pauses des règles : survivent à un redémarrage du service
      try {
        ruleState = restoreRuleState(ruleEventsSince(db, now() - H), now());
      } catch (e) {
        log(`règles: état non restauré : ${(e as Error).message}`);
      }
      writeStatus();
    },

    tick() {
      if (!db || !writer) return;
      try {
        const ts = now();
        const procs = tracker.update(readProcesses(procRoot, { wantCwd, cmdlineCache }), ts);
        const system = readSystem(procRoot);
        const groups = buildGroups(procs, {
          home: homedir(),
          currentUid,
          isProtected: protection.isProtected,
          othersThreshold: { memMB: 0, cpuPercent: 0 },
          projectRootOf,
          claudeDirs: claudeConfigDirs,
        });
        const cpuPercent = procs.reduce((s, p) => s + p.cpuPercent, 0) / ncpu;
        writer.writeTick({ ts, system, cpuPercent, groups, procs }, cfg);
        if (shouldRecordPressure(system.psiSome10, lastPressureTs, ts)) {
          const detail = { psi: system.psiSome10 };
          alert(insertEvent(db, ts, 'pressure', null, detail), ts, 'pressure', null, null, detail);
          lastPressureTs = ts;
        }
        const thresholdKB = cfg.tmpfsAlertMB * 1024;
        const r = shouldRecordTmpfs(system.shmemKB, thresholdKB, tmpfs, ts);
        // état retenu seulement après l'écriture : un échec est retenté au tick suivant
        if (r.record) {
          const detail = { shmemKB: system.shmemKB, thresholdKB };
          alert(insertEvent(db, ts, 'tmpfs', null, detail), ts, 'tmpfs', null, null, detail);
        }
        tmpfs = r.state;
        runForecast(db, ts, system);
        runRules(db, ts, groups);
        st.lastSampleAt = ts;
        ok('tick');
        writeStatus();
      } catch (e) {
        fail('tick', 'tick', e);
      }
    },

    minuteJob() {
      const d = db;
      const w = writer;
      if (!d || !w) return;
      const t = now();
      let firstError: string | null = null;
      // chaque étape est isolée : une étape en échec ne bloque pas les suivantes (notamment la purge)
      const step = (name: string, fn: () => void) => {
        try {
          fn();
        } catch (e) {
          log(`minute(${name}): ${(e as Error).message}`);
          firstError ??= `${name}: ${(e as Error).message ?? String(e)}`;
        }
      };
      step('seuils earlyoom', () => {
        if (t - thresholdsAt < THRESHOLDS_EVERY_MS && t >= thresholdsAt) return;
        thresholds = readEarlyoomThresholds(deps.earlyoomFile);
        thresholdsAt = t;
      });
      step('clear-request', () => {
        if (existsSync(clearRequestPath(deps.dataDir))) {
          clearAll(d);
          w.forget();
          lastMinute = Math.floor(t / M) * M;
          lastHour = Math.floor(lastMinute / H) * H;
          rmSync(clearRequestPath(deps.dataDir), { force: true });
        }
      });
      step('agrégation', () => {
        const current = Math.floor(t / M) * M;
        while (lastMinute < current) {
          aggregateMinute(d, lastMinute);
          lastMinute += M;
        }
      });
      step('agrégation horaire', () => {
        // heures dont toutes les minutes sont agrégées, puis l'heure en cours (recalculée à chaque minute)
        const open = Math.floor(lastMinute / H) * H;
        while (lastHour < open) {
          aggregateHour(d, lastHour);
          lastHour += H;
        }
        aggregateHour(d, open);
      });
      step('événements app', () => {
        const taken = takeAppEvents(appEventsPath(deps.dataDir));
        d.exec('BEGIN');
        try {
          for (const e of taken.events) insertEvent(d, e.ts, 'app_kill', e.groupKey, e.detail);
          d.exec('COMMIT');
        } catch (e) {
          d.exec('ROLLBACK');
          throw e;
        }
        taken.ack();
      });
      step('fuites', () => {
        for (const l of leakCandidates(d, t, cfg.leakMinMinutes, cfg.leakMinGrowthMB)) {
          const detail = { growthKB: l.growthKB, memKB: l.memKB, minutes: cfg.leakMinMinutes };
          alert(insertEvent(d, t, 'leak', l.key, detail), t, 'leak', l.key, l.label, detail);
        }
      });
      step('purge', () => {
        const orphans = purges++ % ORPHANS_EVERY === 0;
        purge(d, t, cfg.detailHours, cfg.summaryDays, { orphans });
        if (orphans) w.forget(); // des lignes procs ont pu disparaître
      });
      step('copies de sécurité', () => {
        const cut = t - cfg.summaryDays * 86400_000;
        for (const b of historyBackups(dbPath(deps.dataDir))) if (b.ts < cut) rmSync(b.file, { force: true });
      });
      if (firstError) fail('minute', 'minute', new Error(firstError));
      else {
        ok('minute');
        writeStatus();
      }
    },

    reloadConfig() {
      const loaded = loadConfig(deps.configDir);
      const c = loaded.config;
      cfg = c.recorder;
      alertsCfg = c.alerts;
      if (JSON.stringify(c.classify.overrides) !== JSON.stringify(overrides) || c.classify.detectPorts !== detectPorts) decisions.clear();
      overrides = c.classify.overrides;
      detectPorts = c.classify.detectPorts;
      protection = compileProtection(c.protected);
      logRuleIssues(loaded.ruleIssues);
      rulesCfg = c.rules;
    },

    setEarlyoomSource(s) {
      st.earlyoomSource = s;
      writeStatus();
    },

    onEarlyoomLine(line) {
      if (!db) return;
      const j = parseJournalLine(line);
      const k = j && parseEarlyoom(j.message);
      if (!j || !k) return;
      let id: number;
      try {
        id = insertEvent(db, j.ts, 'earlyoom_kill', null, k);
      } catch (e) {
        fail('earlyoom', 'earlyoom', e);
        return;
      }
      ok('earlyoom');
      alert(id, j.ts, 'earlyoom_kill', null, null, k);
    },

    stop() {
      db?.close();
      db = null;
      writer = null;
      runner = null;
    },
  };
}
