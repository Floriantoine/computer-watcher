import { execFile, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createInterface } from 'node:readline';

export interface FollowChild {
  stdout: Readable | null;
  on(event: 'error' | 'spawn' | 'exit', cb: () => void): unknown;
  kill(): unknown;
}

export interface JournalDeps {
  execFile: (cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => unknown;
  spawn: (cmd: string, args: string[]) => FollowChild;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  now: () => number;
}

const realDeps: JournalDeps = {
  execFile: (cmd, args, cb) => execFile(cmd, args, { timeout: 5000 }, (err, stdout, stderr) => cb(err, String(stdout), String(stderr))),
  spawn: (cmd, args) => spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }) as unknown as FollowChild,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  now: Date.now,
};

export const RETRY_MIN_MS = 30_000;
export const RETRY_MAX_MS = 600_000;
const UNREADABLE = /permission|not seeing messages|insufficient|no journal files were/i;

/**
 * journalctl est-il utilisable ? Échec, ou message d'accès refusé / « not seeing messages » / journal introuvable → indisponible.
 * L'en-tête « -- No entries -- » seul est normal (earlyoom n'a encore rien écrit).
 */
export function classifyProbe(err: Error | null, stdout: string, stderr: string): 'ok' | 'unavailable' {
  if (err) return 'unavailable';
  return UNREADABLE.test(`${stdout}\n${stderr}`) ? 'unavailable' : 'ok';
}

/** Suit les messages d'earlyoom ; sonde d'abord, relance avec attente croissante si le suivi s'arrête. */
export function followEarlyoom(
  onLine: (line: string) => void,
  onState: (s: 'ok' | 'unavailable') => void,
  overrides: Partial<JournalDeps> = {},
): () => void {
  const d = { ...realDeps, ...overrides };
  let stopped = false;
  let child: FollowChild | null = null;
  let timer: unknown;
  let delay = RETRY_MIN_MS;

  const retry = () => {
    if (stopped) return;
    onState('unavailable');
    const wait = delay;
    delay = Math.min(delay * 2, RETRY_MAX_MS);
    timer = d.setTimeout(attempt, wait);
  };

  const follow = () => {
    const c = d.spawn('journalctl', ['-u', 'earlyoom', '-f', '-o', 'json', '-n', '0']);
    child = c;
    let startedAt = 0;
    let done = false;
    const end = () => {
      if (done || stopped) return;
      done = true;
      if (startedAt && d.now() - startedAt >= 60_000) delay = RETRY_MIN_MS;
      retry();
    };
    c.on('error', end);
    c.on('exit', end);
    c.on('spawn', () => {
      startedAt = d.now();
      onState('ok');
    });
    if (c.stdout) createInterface({ input: c.stdout }).on('line', onLine);
  };

  const attempt = () => {
    if (stopped) return;
    // sans -q : -q masque justement les avertissements « not seeing messages » / journal inaccessible
    d.execFile('journalctl', ['-u', 'earlyoom', '-n', '1', '--no-pager'], (err, stdout, stderr) => {
      if (stopped) return;
      if (classifyProbe(err, stdout, stderr) === 'ok') follow();
      else retry();
    });
  };

  attempt();
  return () => {
    stopped = true;
    if (timer !== undefined) d.clearTimeout(timer);
    child?.kill();
  };
}
