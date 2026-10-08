// src/recorder/notify.ts — notifications du bureau par `notify-send` (execFile, jamais de shell).
import { execFile, type ChildProcess } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export interface NotifyAction { id: string; label: string }
export interface NotifyRequest { title: string; body: string; urgency: 'normal' | 'critical'; actions: NotifyAction[]; waitMs: number }
/** unknown : pas encore détecté ; actions : `--action` supporté ; plain : sans boutons ; unavailable : binaire absent. */
export type NotifierState = 'unknown' | 'actions' | 'plain' | 'unavailable';
export interface Notifier {
  /** Id de l'action cliquée, ou null (fermée, expirée, sans action, binaire absent). Ne rejette jamais. */
  notify(req: NotifyRequest): Promise<string | null>;
  state(): NotifierState;
}

const HELP_TIMEOUT_MS = 2000;
const PLAIN_TIMEOUT_MS = 5000;
/** Binaire absent : nouvelle recherche au plus toutes les 10 min (paquet installé entre-temps). */
const RETRY_MS = 600_000;

export function notifyArgs(req: NotifyRequest, withActions: boolean): string[] {
  return [
    '--app-name=proc-watch',
    `--urgency=${req.urgency}`,
    '--icon=dialog-warning',
    ...(withActions ? req.actions.map((a) => `--action=${a.id}=${a.label}`) : []),
    // fin des options : un titre ou un corps qui commence par « - » reste un texte
    '--',
    req.title,
    req.body,
  ];
}

/** Chemin absolu d'un exécutable d'après PATH (entrées relatives ignorées), ou null. */
export function resolveBin(name: string, pathEnv: string | undefined): string | null {
  for (const dir of (pathEnv ?? '').split(':')) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, name);
    try {
      if (!statSync(p).isFile()) continue;
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // absent ou non exécutable
    }
  }
  return null;
}

type ExecFile = typeof execFile;
interface RunResult { ok: boolean; enoent: boolean; stdout: string; stderr: string }

export function createNotifier(deps: { bin?: string; pathEnv?: string; execFile?: ExecFile; now?: () => number; log?: (m: string) => void } = {}): Notifier {
  const runFile = deps.execFile ?? execFile;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.error(m));
  let st: NotifierState = 'unknown';
  let bin: string | null = null;
  let checkedAt = 0;
  let loggedMissing = false;
  /** Un seul notify-send en attente d'un clic : le précédent est tué quand une nouvelle notification part. */
  let pending: ChildProcess | null = null;

  const run = (args: string[], timeout: number, track: boolean): Promise<RunResult> =>
    new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = runFile(bin!, args, { timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
          if (pending === child) pending = null;
          const code = (err as NodeJS.ErrnoException | null)?.code;
          resolve({ ok: !err, enoent: code === 'ENOENT' || code === 'EACCES', stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        });
      } catch {
        resolve({ ok: false, enoent: true, stdout: '', stderr: '' });
        return;
      }
      if (track) pending = child;
    });

  const missing = () => {
    st = 'unavailable';
    if (!loggedMissing) log('notify-send introuvable : pas de notification du bureau');
    loggedMissing = true;
  };

  async function detect(): Promise<void> {
    if (st === 'actions' || st === 'plain') return;
    if (st === 'unavailable' && now() - checkedAt < RETRY_MS) return;
    checkedAt = now();
    bin = deps.bin ?? resolveBin('notify-send', deps.pathEnv ?? process.env.PATH);
    if (!bin) return missing();
    const r = await run(['--help'], HELP_TIMEOUT_MS, false);
    if (r.enoent) return missing();
    loggedMissing = false;
    st = /--action\b/.test(r.stdout + r.stderr) ? 'actions' : 'plain';
  }

  return {
    state: () => st,
    async notify(req) {
      try {
        await detect();
        if (st !== 'actions' && st !== 'plain') return null;
        const withActions = st === 'actions' && req.actions.length > 0;
        if (pending) pending.kill('SIGKILL');
        const r = await run(notifyArgs(req, withActions), withActions ? req.waitMs : PLAIN_TIMEOUT_MS, true);
        if (r.enoent) {
          missing();
          return null;
        }
        if (withActions && !r.ok && /unknown option/i.test(r.stderr)) {
          st = 'plain';
          log('notify-send refuse --action : notifications sans bouton');
          await run(notifyArgs(req, false), PLAIN_TIMEOUT_MS, true);
          return null;
        }
        if (!withActions || !r.ok) return null;
        const id = r.stdout.trim().split('\n').pop() ?? '';
        return req.actions.some((a) => a.id === id) ? id : null;
      } catch {
        return null;
      }
    },
  };
}
