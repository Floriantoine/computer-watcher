// src/recorder/recorder.ts
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, homedir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { CpuTracker } from '../core/collector/cpuTracker';
import { readProcesses } from '../core/collector/readProcesses';
import { readSystem } from '../core/collector/readSystem';
import { loadConfig } from '../core/config';
import { buildGroups } from '../core/grouping/buildGroups';
import { createProjectRootCache } from '../core/grouping/projectRootCache';
import { DEV_TOOL } from '../core/grouping/rules';
import { historyBackups, openHistoryDb } from '../core/history/db';
import {
  detectGap, insertEvent, lastEventTs, lastSampleTs, parseEarlyoom, parseJournalLine, shouldRecordPressure, shouldRecordTmpfs, takeAppEvents,
  type TmpfsAlertState,
} from '../core/history/events';
import { aggregateHour, aggregateMinute, clearAll, leakCandidates, purge } from '../core/history/maintenance';
import { HistoryWriter } from '../core/history/writer';
import { appEventsPath, clearRequestPath, dbPath, statusPath } from '../core/paths';
import type { RecorderConfig, RecorderStatus } from '../core/types';

export interface RecorderDeps {
  dataDir: string;
  configDir: string;
  procRoot?: string;
  now?: () => number;
  cpuCount?: number;
  log?: (msg: string) => void;
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
}

const M = 60_000;
const H = 3600_000;
/** Le nettoyage des processus/groupes orphelins (parcours complet) ne tourne qu'une minute sur 10. */
const ORPHANS_EVERY = 10;

export function createRecorder(deps: RecorderDeps): Recorder {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.error(m));
  const procRoot = deps.procRoot ?? '/proc';
  const ncpu = deps.cpuCount ?? Math.max(1, cpus().length);
  const tracker = new CpuTracker();
  const cmdlineCache = new Map<string, string>();
  const projectRootOf = createProjectRootCache();
  const wantCwd = (name: string) => DEV_TOOL.test(name);
  let cfg: RecorderConfig = loadConfig(deps.configDir).config.recorder;
  let db: DatabaseSync | null = null;
  let writer: HistoryWriter | null = null;
  let lastMinute = 0;
  /** Première heure pas encore close dans les tables horaires. */
  let lastHour = 0;
  let purges = 0;
  const st: RecorderStatus = { pid: process.pid, startedAt: now(), lastSampleAt: null, lastError: null, earlyoomSource: 'unavailable', dbSizeBytes: 0, warning: null };

  type Job = 'tick' | 'minute' | 'earlyoom';
  const jobErrors: Record<Job, string | null> = { tick: null, minute: null, earlyoom: null };
  const errorAt: Record<Job, number> = { tick: 0, minute: 0, earlyoom: 0 };
  let errSeq = 0;
  st.jobErrors = jobErrors;
  let lastPressureTs: number | null = null;
  let tmpfs: TmpfsAlertState = { lastTs: null, armed: false };

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
    for (const j of ['tick', 'minute', 'earlyoom'] as Job[]) if (jobErrors[j] && (!best || errorAt[j] > errorAt[best])) best = j;
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

  return {
    config: () => cfg,
    status: () => ({ ...st }),

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
      tmpfs = { lastTs: lastEventTs(db, 'tmpfs'), armed: false };
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
          currentUid: process.getuid?.() ?? -1,
          isProtected: () => false,
          othersThreshold: { memMB: 0, cpuPercent: 0 },
          projectRootOf,
        });
        const cpuPercent = procs.reduce((s, p) => s + p.cpuPercent, 0) / ncpu;
        writer.writeTick({ ts, system, cpuPercent, groups, procs }, cfg);
        if (shouldRecordPressure(system.psiSome10, lastPressureTs, ts)) {
          insertEvent(db, ts, 'pressure', null, { psi: system.psiSome10 });
          lastPressureTs = ts;
        }
        const thresholdKB = cfg.tmpfsAlertMB * 1024;
        const r = shouldRecordTmpfs(system.shmemKB, thresholdKB, tmpfs, ts);
        tmpfs = r.state;
        if (r.record) insertEvent(db, ts, 'tmpfs', null, { shmemKB: system.shmemKB, thresholdKB });
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
          insertEvent(d, t, 'leak', l.key, { growthKB: l.growthKB, memKB: l.memKB, minutes: cfg.leakMinMinutes });
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
      cfg = loadConfig(deps.configDir).config.recorder;
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
      try {
        insertEvent(db, j.ts, 'earlyoom_kill', null, k);
      } catch (e) {
        fail('earlyoom', 'earlyoom', e);
        return;
      }
      ok('earlyoom');
    },

    stop() {
      db?.close();
      db = null;
      writer = null;
    },
  };
}
