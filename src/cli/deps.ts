// Vraies dépendances de `computer-watcher run` : /proc, /sys/fs/cgroup, antigel-state.json (lecture seule), busctl par
// systemBin (execFile sans shell, environnement nettoyé), execve.
import { accessSync, closeSync, constants, existsSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { probeAvailability, readCgroup, readCgroupStats } from '../core/antigel/cgroupfs';
import { parseAntigelState } from '../core/antigel/state';
import { readStateFileBounded } from '../core/antigel/stateFile';
import { createBusctl } from '../core/antigel/systemd';
import { systemBin } from '../core/childEnv';
import { findProjectRoot } from '../core/grouping/projectRoot';
import { antigelStatePath, dataDir } from '../core/paths';
import { execCommand } from './exec';
import { resolveCommand, type CliDeps, type FsLike } from './run';

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
        const b = Buffer.alloc(4);
        return b.subarray(0, readSync(fd, b, 0, 4, 0));
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
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
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
