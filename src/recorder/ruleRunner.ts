// src/recorder/ruleRunner.ts — exécution des décisions du moteur de règles dans le service d'enregistrement.
// Simulation : un événement, jamais `kill` ni `readProcs`. Active : liste « jamais tuer » revérifiée sur un /proc relu,
// puis planKill (pid + startTicks, uid, jamais soi-même) → SIGTERM ; 5 s plus tard, même revérification et SIGKILL
// aux seuls processus encore vivants avec le même startTicks.
import type { DatabaseSync } from 'node:sqlite';
import type { AlertEvent } from '../core/alerts';
import { insertEvent } from '../core/history/events';
import { planKill, sendSignals, type KillFn } from '../core/kill';
import type { RuleDecision, RuleTarget } from '../core/rules/engine';
import { filterTargets } from '../core/rules/neverKill';
import type { KillResult, KillSignal, KillTarget, ProcSample } from '../core/types';

export const ESCALATE_MS = 5000;

export interface RuleRunnerDeps {
  db: DatabaseSync;
  kill: KillFn;
  readProcs: () => ProcSample[];
  selfPid: number;
  currentUid: number;
  /** Dossier de l'app proc-watch (jamais visée), null si inconnu. */
  appRoot: string | null;
  /** Liste protégée courante (relue avec la config). */
  isProtected: (name: string) => boolean;
  /** Pop-up et notification du bureau pour un événement enregistré (selon son canal). */
  notify: (e: AlertEvent) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  /** Horloge murale (horodatage des événements). */
  now: () => number;
  /** Horloge monotone (anti-spam des notifications de quota) ; absente → `now`. */
  monoNow?: () => number;
  log: (m: string) => void;
  /**
   * Révision actuelle de la règle si elle peut encore agir (interrupteur général allumé, règle présente, activée, Active
   * effective), sinon null. Relue juste avant le SIGTERM et avant le SIGKILL : différente de celle de la décision → aucun
   * signal. Absente → aucun signal (échec fermé).
   */
  ruleRevision?: (ruleId: string) => string | null;
  /** Dossiers de config de Claude (chemins réels) : processus qui y travaillent, et leurs descendants, jamais visés. */
  claudeDirs?: readonly string[];
  /** Pids du groupe Claude du dernier instantané. */
  claudePids?: () => ReadonlySet<number>;
}

/** Une seule notification « quota atteint » par heure, toutes règles confondues. */
export const QUOTA_NOTIFY_EVERY_MS = 3600_000;

/** `kill` effectif du service : PROC_WATCH_NO_KILL=1 → aucun signal, chaque appel échoue en NOKILL (journalisé). */
export function serviceKill(
  env: NodeJS.ProcessEnv = process.env,
  real: KillFn = (pid, s) => process.kill(pid, s),
  log: (m: string) => void = (m) => console.error(m),
): KillFn {
  if (env.PROC_WATCH_NO_KILL !== '1') return real;
  return (pid, signal) => {
    log(`règles: PROC_WATCH_NO_KILL=1, ${signal} non envoyé au processus ${pid}`);
    throw Object.assign(new Error('PROC_WATCH_NO_KILL'), { code: 'NOKILL' });
  };
}

const targetsDetail = (t: RuleTarget) => t.targets.map((x, i) => ({ name: t.names[i] ?? '?', pid: x.pid, memKB: t.memKBs[i] ?? 0 }));

export function createRuleRunner(deps: RuleRunnerDeps): { run(decisions: readonly RuleDecision[]): void; pendingEscalations(): number } {
  let pending = 0;
  const mono = deps.monoNow ?? deps.now;
  let lastQuotaNotify: number | null = null;
  /** La règle de la décision peut-elle encore agir, telle qu'elle était ? Sinon journalisé et rien n'est envoyé. */
  const stillValid = (d: Extract<RuleDecision, { outcome: 'fire' }>, what: string): boolean => {
    let current: string | null = null;
    try {
      current = deps.ruleRevision ? deps.ruleRevision(d.ruleId) : null;
    } catch {
      current = null;
    }
    if (current !== null && current === d.revision) return true;
    deps.log(`règles: « ${d.ruleName} » : ${what} annulé (interrupteur éteint, règle supprimée, désactivée, en Simulation ou modifiée)`);
    return false;
  };

  const record = (type: 'rule_action' | 'rule_dry_run', groupKey: string | null, detail: Record<string, unknown>, notify: boolean) => {
    const ts = deps.now();
    const id = insertEvent(deps.db, ts, type, groupKey, detail);
    if (notify) deps.notify({ id, ts, type, groupKey, groupLabel: null, detail });
  };

  /**
   * Revérifie la liste « jamais tuer » (processus relus maintenant) puis planKill, et envoie `signal`.
   * Les cibles refusées par la liste portent l'erreur `GUARD:<raison>`.
   */
  const signal = (targets: readonly KillTarget[], sig: KillSignal): { results: KillResult[]; sent: KillTarget[] } => {
    const procs = deps.readProcs();
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    // identité d'abord (pid réutilisé → ESRCH par planKill), puis la liste « jamais tuer » sur le processus tel qu'il est maintenant
    const same = targets.filter((t) => byPid.get(t.pid)?.startTicks === t.startTicks);
    const { kept, refused } = filterTargets(same.map((t) => t.pid), {
      byPid, currentUid: deps.currentUid, selfPid: deps.selfPid, appRoot: deps.appRoot, isProtected: deps.isProtected,
      claudeDirs: deps.claudeDirs, claudePids: deps.claudePids?.(),
    });
    const keptSet = new Set(kept);
    const guardRefused: KillResult[] = [...refused].map(([pid, why]) => ({ pid, ok: false, error: `GUARD:${why}` }));
    const plan = planKill(targets.filter((t) => keptSet.has(t.pid) || !byPid.has(t.pid) || byPid.get(t.pid)!.startTicks !== t.startTicks), procs, {
      selfPid: deps.selfPid, currentUid: deps.currentUid,
    });
    const allowed = plan.ordered.filter((pid) => keptSet.has(pid));
    const results = [...guardRefused, ...plan.refused, ...sendSignals(allowed, sig, deps.kill)];
    const ok = new Set(results.filter((r) => r.ok).map((r) => r.pid));
    return { results, sent: targets.filter((t) => ok.has(t.pid)) };
  };

  const escalate = (d: Extract<RuleDecision, { outcome: 'fire' }>, sent: KillTarget[]) => {
    try {
      if (!stillValid(d, 'SIGKILL')) return;
      const { results } = signal(sent, 'SIGKILL');
      const killed = results.filter((r) => r.ok).length;
      if (killed > 0) {
        record('rule_action', d.target.groupKey, {
          ruleId: d.ruleId, rule: d.ruleName, target: d.target.label, memKB: d.target.memKB, signal: 'SIGKILL', killed,
          refused: results.filter((r) => !r.ok && r.error !== 'ESRCH').map((r) => ({ pid: r.pid, error: r.error })), result: 'sigkill',
        }, false);
      }
    } catch (e) {
      deps.log(`règles: escalade « ${d.ruleName} » : ${(e as Error).message}`);
    } finally {
      pending--;
    }
  };

  const act = (d: Extract<RuleDecision, { outcome: 'fire' }>) => {
    if (!stillValid(d, 'SIGTERM')) return;
    const t = d.target;
    const { results, sent } = signal(t.targets, 'SIGTERM');
    const killed = sent.length;
    record('rule_action', t.groupKey, {
      ruleId: d.ruleId, rule: d.ruleName, target: t.label, memKB: t.memKB, pids: t.targets.map((x) => x.pid), targets: targetsDetail(t),
      signal: 'SIGTERM', killed, refused: results.filter((r) => !r.ok).map((r) => ({ pid: r.pid, error: r.error })),
      result: killed > 0 ? 'sigterm' : 'refused',
    }, true);
    if (killed > 0) {
      pending++;
      deps.setTimeout(() => escalate(d, sent), ESCALATE_MS);
    }
  };

  return {
    pendingEscalations: () => pending,
    run(decisions) {
      for (const d of decisions) {
        try {
          if (d.outcome === 'skip') {
            if (d.reason === 'guard') {
              deps.log(`règles: « ${d.ruleName} » : rien à arrêter${d.target?.excluded ? ` (${d.target.excluded} processus exclus par les garde-fous)` : ''}`);
            } else if (d.reason === 'hourly-quota') {
              const m = mono();
              const notify = lastQuotaNotify === null || m - lastQuotaNotify >= QUOTA_NOTIFY_EVERY_MS;
              if (notify) lastQuotaNotify = m;
              record(d.mode === 'active' ? 'rule_action' : 'rule_dry_run', d.target?.groupKey ?? null, {
                ruleId: d.ruleId, rule: d.ruleName, target: d.target?.label ?? null, result: 'quota',
              }, notify);
            }
            continue;
          }
          if (d.mode === 'simulate') {
            // Simulation : ni readProcs, ni planKill, ni kill.
            record('rule_dry_run', d.target.groupKey, {
              ruleId: d.ruleId, rule: d.ruleName, target: d.target.label, memKB: d.target.memKB, pids: d.target.targets.map((x) => x.pid),
              targets: targetsDetail(d.target), result: 'dry_run',
            }, true);
            continue;
          }
          act(d);
        } catch (e) {
          deps.log(`règles: « ${d.ruleName} » : ${(e as Error).message}`);
        }
      }
    },
  };
}
