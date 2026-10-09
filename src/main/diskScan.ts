// Parcours du dossier personnel pour le soleil de la page Disque : dans un processus enfant (le main reste fluide), à
// basse priorité (nice 19, ionice idle), avec budget de temps et d'entrées ; résultat gardé 10 min.
import { execFile, fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cleanEnv, systemBin } from '../core/childEnv';
import type { SunNode } from '../core/disk/sunTree';
import type { ScanRequest } from './diskScanWorker';

export interface ScanResult { tree: SunNode; truncated: boolean; at: number; priority: number | null }

export interface ScanDeps {
  /** Point d'entrée du processus enfant (défaut : diskScanWorker.js à côté du main construit). */
  workerPath?: string;
  /** Classe d'E/S « idle » pour le processus enfant (défaut : `ionice -c3 -p <pid>`, échec ignoré). */
  ionice?: (pid: number) => void;
  /** Tests : attente du processus enfant avant le parcours. */
  startDelayMs?: number;
}

export const SCAN_LIMITS = { nice: 19, maxDepth: 6, minShare: 0.005, maxEntries: 3_000_000, budgetMs: 120_000 } as const;

function idleIo(pid: number): void {
  const bin = systemBin('ionice', existsSync);
  if (!bin) return;
  execFile(bin, ['-c3', '-p', String(pid)], { timeout: 3000, env: cleanEnv(process.env) }, () => {});
}

const cancelled = () => new Error('Parcours annulé');

export function scanHome(home: string, o: { onProgress(kb: number): void; signal: AbortSignal }, d: ScanDeps = {}): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    if (o.signal.aborted) return reject(cancelled());
    // execArgv vide : jamais les options de l'app (inspecteur…) ; ELECTRON_RUN_AS_NODE : le binaire d'Electron en Node
    const child = fork(d.workerPath ?? join(__dirname, 'diskScanWorker.js'), [], {
      execArgv: [], env: { ...cleanEnv(process.env), ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      o.signal.removeEventListener('abort', onAbort);
      fn();
    };
    const kill = () => {
      // par son PID, jamais par motif de nom
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    let aborted = false;
    // rejet après la fin effective du processus enfant (événement exit)
    const onAbort = () => {
      aborted = true;
      kill();
    };
    o.signal.addEventListener('abort', onAbort);
    child.on('spawn', () => {
      if (child.pid) (d.ionice ?? idleIo)(child.pid);
      if (aborted || o.signal.aborted) return kill();
      const req: ScanRequest = { type: 'scan', root: home, ...SCAN_LIMITS, ...(d.startDelayMs ? { startDelayMs: d.startDelayMs } : {}) };
      child.send(req);
    });
    child.on('message', (m: { type: string; kb?: number; tree?: SunNode; truncated?: boolean; priority?: number; message?: string }) => {
      if (m?.type === 'progress' && typeof m.kb === 'number') o.onProgress(m.kb);
      else if (aborted) return;
      else if (m?.type === 'done' && m.tree) finish(() => resolve({ tree: m.tree!, truncated: !!m.truncated, at: Date.now(), priority: m.priority ?? null }));
      else if (m?.type === 'error') finish(() => reject(new Error(m.message ?? 'parcours en échec')));
    });
    child.on('error', (e) => finish(() => reject(e)));
    child.on('exit', (code, sig) => finish(() => reject(aborted ? cancelled() : new Error(`parcours interrompu (${sig ?? `code ${code}`})`))));
  });
}

export const SCAN_CACHE_MS = 10 * 60_000;
export const SCAN_LEAVE_MS = 30_000;

type Timer = unknown;
export interface ScanCacheDeps {
  scan(o: { onProgress(kb: number): void }, signal: AbortSignal): Promise<ScanResult>;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => Timer;
  clearTimeout?: (t: Timer) => void;
}

/**
 * Un seul parcours à la fois (les demandes simultanées le partagent), résultat gardé 10 min ; `leave` (page quittée)
 * annule le parcours en cours après 30 s, sauf nouvelle demande d'ici là.
 */
export function createScanCache(d: ScanCacheDeps) {
  const now = d.now ?? Date.now;
  const setT = d.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = d.clearTimeout ?? ((t: Timer) => clearTimeout(t as NodeJS.Timeout));
  let cached: ScanResult | null = null;
  let running: { promise: Promise<ScanResult>; ac: AbortController; listeners: Set<(kb: number) => void> } | null = null;
  let leaveTimer: Timer | null = null;
  const stopLeave = () => {
    if (leaveTimer !== null) clearT(leaveTimer);
    leaveTimer = null;
  };
  return {
    scan(onProgress: (kb: number) => void, o: { force?: boolean } = {}): Promise<ScanResult> {
      stopLeave();
      if (!o.force && cached && now() - cached.at >= 0 && now() - cached.at < SCAN_CACHE_MS) return Promise.resolve(cached);
      if (running) {
        running.listeners.add(onProgress);
        return running.promise;
      }
      const ac = new AbortController();
      const listeners = new Set([onProgress]);
      const promise = d.scan({ onProgress: (kb) => listeners.forEach((l) => l(kb)) }, ac.signal).then(
        (r) => {
          cached = { ...r, at: now() };
          running = null;
          return cached;
        },
        (e: unknown) => {
          running = null;
          throw e;
        },
      );
      running = { promise, ac, listeners };
      return promise;
    },
    leave() {
      stopLeave();
      if (!running) return;
      const r = running;
      leaveTimer = setT(() => {
        leaveTimer = null;
        r.ac.abort();
      }, SCAN_LEAVE_MS);
    },
    clear() {
      cached = null;
    },
    cached: () => cached,
  };
}
