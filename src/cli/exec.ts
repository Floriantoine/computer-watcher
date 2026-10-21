// `computer-watcher run` : remplacement du lanceur par la commande.
// execve (process.execve, Node ≥ 22.15 / Electron 44) : la commande garde le PID du lanceur, donc son terminal, son
// groupe de processus (Ctrl+C), ses signaux et son code de sortie, sans processus intermédiaire. Les descripteurs ≥ 3
// hérités (Electron, libuv) sont fermés juste avant : la commande ne reçoit que 0, 1 et 2.
// Repli (process.execve absent) : enfant avec les mêmes entrées/sorties, signaux transmis, code de sortie renvoyé.
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { constants } from 'node:os';

/** Masque du sens d'ouverture (O_RDONLY, O_WRONLY, O_RDWR) : absent de fs.constants. */
const O_ACCMODE = 3;

/**
 * Tube hérité rouvert par /proc/self/fd/<fd> (même tube, même sens) : Node ouvre toujours avec O_CLOEXEC, le noyau le
 * fermera donc à l'execve même. true si c'est fait (l'original peut être fermé sans fermer le tube avant l'exec).
 */
export function reopenPipeCloexec(fd: number): boolean {
  try {
    if (!fstatSync(fd).isFIFO()) return false;
    const m = /^flags:\s+([0-7]+)\s*$/m.exec(readFdinfo(fd) ?? '');
    if (!m) return false;
    // O_NONBLOCK : jamais d'attente (écriture sans lecteur : ENXIO, le tube est alors simplement fermé)
    openSync(`/proc/self/fd/${fd}`, (parseInt(m[1]!, 8) & O_ACCMODE) | fsConstants.O_NONBLOCK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Descripteurs ≥ 3 hérités fermés avant l'execve ; un tube est d'abord rouvert avec O_CLOEXEC (reopenPipeCloexec) et ne
 * se ferme donc qu'à l'execve même. Raison : le runtime AppImage garde son montage tant qu'un descripteur de son tube
 * « keepalive » reste ouvert ; fermé avant l'execve, le montage disparaît pendant que Node tourne encore depuis lui
 * (SIGBUS, code 135, constaté avec une vraie AppImage).
 */
export function closeInheritedFds(
  list: () => string[] = () => readdirSync('/proc/self/fd'), close: (fd: number) => void = closeSync,
  keepUntilExec: (fd: number) => boolean = reopenPipeCloexec,
): void {
  for (const s of list()) {
    const fd = Number(s);
    if (!Number.isInteger(fd) || fd <= 2) continue;
    try {
      keepUntilExec(fd);
      close(fd);
    } catch {
      // déjà fermé (descripteur du readdir lui-même)
    }
  }
}

/** Drapeau O_NONBLOCK (octal 04000) dans /proc/self/fdinfo/<fd> ; false si illisible. */
export function isNonBlocking(fdinfo: string | null): boolean {
  const m = fdinfo === null ? null : /^flags:\s+([0-7]+)\s*$/m.exec(fdinfo);
  return m !== null && (parseInt(m[1]!, 8) & 0o4000) !== 0;
}

const readFdinfo = (fd: number): string | null => {
  try {
    return readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8');
  } catch {
    return null;
  }
};
interface Blockable { _handle?: { setBlocking?: (b: boolean) => unknown } | null }
const stdStream = (fd: number): Blockable => (fd === 0 ? process.stdin : fd === 1 ? process.stdout : process.stderr) as unknown as Blockable;

/**
 * Entrée et sorties rendues bloquantes avant l'exec : Electron en mode complet (entrée de l'app) pose O_NONBLOCK sur la
 * sortie d'erreur, et ce drapeau du descripteur partagé serait gardé par la commande (écritures perdues en EAGAIN dans
 * un `2>&1 | tee`). Seuls les descripteurs qui l'ont sont touchés (uv_stream_set_blocking par la poignée de Node).
 */
export function restoreBlocking(read: (fd: number) => string | null = readFdinfo, stream: (fd: number) => Blockable = stdStream): void {
  for (const fd of [0, 1, 2]) {
    if (!isNonBlocking(read(fd))) continue;
    try {
      stream(fd)._handle?.setBlocking?.(true);
    } catch {
      // poignée sans setBlocking (fichier) : O_NONBLOCK y est sans effet
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
export function execCommand(
  file: string, argv: string[], env: NodeJS.ProcessEnv, proc: ProcLike = process as unknown as ProcLike, sp: SpawnLike = spawn, closeFds = closeInheritedFds,
  blocking: () => void = restoreBlocking,
): Promise<number> {
  if (typeof proc.execve === 'function') {
    blocking();
    // Node ignore SIGPIPE et SIGXFSZ (SIG_IGN), et un signal ignoré le reste après execve : un gestionnaire le remet à
    // l'action par défaut pour la commande (`yes | head -1` finit par SIGPIPE, comme lancé directement).
    for (const s of RESET_AT_EXEC) proc.on(s, noop);
    closeFds();
    proc.execve(file, argv, env);
    return new Promise(() => {}); // jamais atteint : execve ne rend pas la main (un échec abat le processus)
  }
  return spawnAndWait(file, argv, env, proc, sp);
}

const noop = () => {};
export const RESET_AT_EXEC: NodeJS.Signals[] = ['SIGPIPE', 'SIGXFSZ'];

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
