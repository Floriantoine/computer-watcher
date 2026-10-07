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
import { openHistoryDb } from '../core/history/db';
import {
  detectGap, insertEvent, lastEventTs, lastSampleTs, parseEarlyoom, parseJournalLine, shouldRecordPressure, takeAppEvents,
} from '../core/history/events';
import { aggregateMinute, clearAll, leakCandidates, purge } from '../core/history/maintenance';
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
  const st: RecorderStatus = { pid: process.pid, startedAt: now(), lastSampleAt: null, lastError: null, earlyoomSource: 'unavailable', dbSizeBytes: 0 };

  const writeStatus = () => {
    try {
      st.dbSizeBytes = existsSync(dbPath(deps.dataDir)) ? statSync(dbPath(deps.dataDir)).size : 0;
      const tmp = `${statusPath(deps.dataDir)}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(st));
      renameSync(tmp, statusPath(deps.dataDir));
    } catch (e) {
      log(`status: ${(e as Error).message}`);
    }
  };

  const fail = (where: string, e: unknown) => {
    st.lastError = `${where}: ${(e as Error).message ?? String(e)}`;
    log(st.lastError);
    writeStatus();
  };

  return {
    config: () => cfg,
    status: () => ({ ...st }),

    start() {
      mkdirSync(deps.dataDir, { recursive: true, mode: 0o700 });
      const opened = openHistoryDb(dbPath(deps.dataDir), { now });
      db = opened.db;
      writer = new HistoryWriter(db);
      if (opened.recreated) {
        insertEvent(db, now(), 'gap', null, { reason: 'base illisible, recréée', backup: opened.recreated });
      }
      const gap = detectGap(lastSampleTs(db), now(), cfg.intervalSec);
      if (gap) insertEvent(db, now(), 'gap', null, gap);
      lastMinute = Math.floor(now() / M) * M;
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
        if (shouldRecordPressure(system.psiSome10, lastEventTs(db, 'pressure'), ts)) {
          insertEvent(db, ts, 'pressure', null, { psi: system.psiSome10 });
        }
        st.lastSampleAt = ts;
        st.lastError = null;
        writeStatus();
      } catch (e) {
        fail('tick', e);
      }
    },

    minuteJob() {
      if (!db || !writer) return;
      try {
        const t = now();
        if (existsSync(clearRequestPath(deps.dataDir))) {
          clearAll(db);
          writer.forget();
          rmSync(clearRequestPath(deps.dataDir), { force: true });
        }
        const current = Math.floor(t / M) * M;
        for (let m = lastMinute; m < current; m += M) aggregateMinute(db, m);
        lastMinute = current;
        const taken = takeAppEvents(appEventsPath(deps.dataDir));
        for (const e of taken.events) insertEvent(db, e.ts, 'app_kill', e.groupKey, e.detail);
        taken.ack();
        for (const l of leakCandidates(db, t, cfg.leakMinMinutes, cfg.leakMinGrowthMB)) {
          insertEvent(db, t, 'leak', l.key, { growthKB: l.growthKB, minutes: cfg.leakMinMinutes });
        }
        purge(db, t, cfg.detailHours, cfg.summaryDays);
        writer.forget();
        writeStatus();
      } catch (e) {
        fail('minute', e);
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
        fail('earlyoom', e);
      }
    },

    stop() {
      db?.close();
      db = null;
      writer = null;
    },
  };
}
