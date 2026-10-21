// Vraies dépendances de `computer-watcher run` : /proc, /sys/fs/cgroup, antigel-state.json (lecture seule), busctl par
// systemBin (execFile sans shell, environnement nettoyé), execve.
import { accessSync, closeSync, constants, existsSync, openSync, readSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { probeAvailability, readCgroup, readCgroupStats } from '../core/antigel/cgroupfs';
import { parseAntigelState } from '../core/antigel/state';
import { readStateFileBounded } from '../core/antigel/stateFile';
import { createBusctl } from '../core/antigel/systemd';
import { systemBin } from '../core/childEnv';
import { findProjectRoot } from '../core/grouping/projectRoot';
import { antigelStatePath, dataDir } from '../core/paths';
import { execCommand } from './exec';
import { HEAD_BYTES, resolveCommand, type CliDeps, type FsLike } from './run';

const PROC = '/proc';
const SYSFS = '/sys/fs/cgroup';

export const realFs: FsLike = {
  kind: (p) => {
    try {
      const s = statSync(p);
      return s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other';
    } catch {
      return null;
    }
  },
  executable: (p) => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  head: (p) => {
    try {
      const fd = openSync(p, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const b = Buffer.alloc(HEAD_BYTES);
        return b.subarray(0, readSync(fd, b, 0, HEAD_BYTES, 0));
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
  },
  readAt: (p, pos, len) => {
    try {
      const fd = openSync(p, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const b = Buffer.alloc(len);
        return b.subarray(0, readSync(fd, b, 0, len, pos));
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
  },
};

function attribution(env: NodeJS.ProcessEnv, home: string): Map<string, string | null> {
  try {
    const text = readStateFileBounded(antigelStatePath(dataDir(env, home)));
    const st = text === null ? null : parseAntigelState(text);
    return new Map(st ? Object.entries(st.slices) : []);
  } catch {
    return new Map();
  }
}

/**
 * Écriture directe sur le descripteur, jamais par process.stdout / process.stderr : sur un pipe, libuv y poserait
 * O_NONBLOCK, que l'execve garderait pour la commande (écritures perdues en EAGAIN dans un `2>&1 | tee`).
 */
export function writeOut(fd: 1 | 2, s: string): void {
  try {
    writeSync(fd, s);
  } catch {
    // sortie fermée : rien à faire
  }
}

function currentDir(): string | null {
  try {
    return process.cwd();
  } catch {
    return null; // dossier courant supprimé
  }
}

export function realCliDeps(): CliDeps {
  const env = process.env;
  const home = homedir();
  const uid = process.getuid?.() ?? -1;
  const busctl = systemBin('busctl', existsSync);
  return {
    env,
    cwd: currentDir(),
    home,
    pid: process.pid,
    stdout: (s) => writeOut(1, s),
    stderr: (s) => writeOut(2, s),
    probe: () => probeAvailability({ procRoot: PROC, sysfsRoot: SYSFS, uid, selfPid: process.pid, busctl }),
    stats: (cg) => readCgroupStats(SYSFS, cg),
    findRoot: (cwd) => findProjectRoot(cwd, existsSync, home),
    attribution: () => attribution(env, home),
    busctl: busctl ? createBusctl(busctl, env) : null,
    selfCgroup: () => readCgroup(PROC, process.pid),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => performance.now(),
    resolve: (command, e, cwd) => resolveCommand(command, e, cwd, realFs),
    exec: (file, argv, e) => execCommand(file, argv, e),
  };
}
