// `computer-watcher run` : remplacement du lanceur par la commande.
// execve (process.execve, Node ≥ 22.15 / Electron 44) : la commande garde le PID du lanceur, donc son terminal, son
// groupe de processus (Ctrl+C), ses signaux et son code de sortie, sans processus intermédiaire. Les descripteurs ≥ 3
// hérités (Electron, libuv) sont fermés juste avant : la commande ne reçoit que 0, 1 et 2.
// Repli (process.execve absent) : enfant avec les mêmes entrées/sorties, signaux transmis, code de sortie renvoyé.
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { closeSync, readdirSync } from 'node:fs';
import { constants } from 'node:os';

export function closeInheritedFds(list: () => string[] = () => readdirSync('/proc/self/fd'), close: (fd: number) => void = closeSync): void {
  for (const s of list()) {
    const fd = Number(s);
    if (!Number.isInteger(fd) || fd <= 2) continue;
    try {
      close(fd);
    } catch {
      // déjà fermé (descripteur du readdir lui-même)
    }
  }
}

type Execve = (file: string, args: string[], env: NodeJS.ProcessEnv) => never;
type SpawnLike = (file: string, args: string[], opts: SpawnOptions) => ChildProcess;
export interface ProcLike {
  execve?: Execve;
  on(sig: NodeJS.Signals, h: () => void): unknown;
  off(sig: NodeJS.Signals, h: () => void): unknown;
  kill(pid: number, sig: NodeJS.Signals): unknown;
  pid: number;
  stderr: { write(s: string): unknown };
}

/** Remplace le processus par la commande ; ne rend la main que dans le repli sans execve (code de sortie de la commande). */
export function execCommand(file: string, argv: string[], env: NodeJS.ProcessEnv, proc: ProcLike = process as unknown as ProcLike, sp: SpawnLike = spawn, closeFds = closeInheritedFds): Promise<number> {
  if (typeof proc.execve === 'function') {
    closeFds();
    proc.execve(file, argv, env);
    return new Promise(() => {}); // jamais atteint : execve ne rend pas la main (un échec abat le processus)
  }
  return spawnAndWait(file, argv, env, proc, sp);
}

/** Signaux transmis à l'enfant ; SIGINT et SIGQUIT viennent du terminal à tout le groupe : le lanceur attend seulement. */
const FORWARD: NodeJS.Signals[] = ['SIGTERM', 'SIGHUP'];
const WAIT: NodeJS.Signals[] = ['SIGINT', 'SIGQUIT'];

export function spawnAndWait(file: string, argv: string[], env: NodeJS.ProcessEnv, proc: ProcLike, sp: SpawnLike): Promise<number> {
  return new Promise((resolve) => {
    const child = sp(file, argv.slice(1), { argv0: argv[0], stdio: 'inherit', env });
    const handlers = [...FORWARD, ...WAIT].map((s) => [s, () => { if (FORWARD.includes(s)) child.kill(s); }] as const);
    for (const [s, h] of handlers) proc.on(s, h);
    const cleanup = () => {
      for (const [s, h] of handlers) proc.off(s, h);
    };
    child.on('error', (e) => {
      cleanup();
      proc.stderr.write(`computer-watcher run : ${e.message}\n`);
      resolve(127);
    });
    child.on('exit', (code, sig) => {
      cleanup();
      if (sig) {
        // même fin que la commande : tué par le même signal (le shell affiche et compte pareil)
        proc.kill(proc.pid, sig);
        resolve(128 + (constants.signals[sig] ?? 0));
        return;
      }
      resolve(code ?? 1);
    });
  });
}
