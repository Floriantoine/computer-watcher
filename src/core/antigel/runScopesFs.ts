// Anti-gel (lot 4) : lectures (seules) des scopes `computer-watcher run` pour le contrôleur : entrées d'un dossier de
// cgroup, cgroup.procs, dossier courant d'un processus. Bornées, sans suivre de chemin hors de la racine donnée.
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { RunScopeDeps } from './runScopes';

const MAX_ENTRIES = 512;
const MAX_PIDS = 4096;
const safe = (cg: string) => cg.startsWith('/') && !cg.split('/').some((s) => s === '..' || s === '.');

export function runScopeDeps(procRoot: string, sysfsRoot: string): RunScopeDeps {
  return {
    listDir: (cg) => {
      if (!safe(cg)) return null;
      try {
        return readdirSync(join(sysfsRoot, cg), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).slice(0, MAX_ENTRIES);
      } catch {
        return null;
      }
    },
    procsOf: (cg) => {
      if (!safe(cg)) return null;
      try {
        const out: number[] = [];
        for (const l of readFileSync(join(sysfsRoot, cg, 'cgroup.procs'), 'utf8').split('\n')) {
          if (!/^\d{1,7}$/.test(l)) continue;
          out.push(Number(l));
          if (out.length >= MAX_PIDS) break;
        }
        return out;
      } catch {
        return null;
      }
    },
    cwdOf: (pid) => {
      if (!Number.isInteger(pid) || pid <= 0) return null;
      try {
        const l = readlinkSync(join(procRoot, String(pid), 'cwd'));
        return l.startsWith('/') && !l.endsWith(' (deleted)') ? l : null;
      } catch {
        return null;
      }
    },
  };
}
