// Vraies dépendances de l'anti-gel pour le service : busctl (systemBin), /proc, /sys/fs/cgroup. Coupées par
// PROC_WATCH_NO_ANTIGEL=1 (scripts de mesure et de bout en bout du service, apps de test : aucun vrai processus déplacé).
// Rien n'est lancé ni lu à la construction : busctl ne part qu'à un appel du client, depuis l'orchestrateur du service.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { probeAvailability, readCgroup, readCgroupStats, reverify } from '../core/antigel/cgroupfs';
import { sanitizeOriginals, type DeskDeps, type DeskFile, type DeskOriginals } from '../core/antigel/desk';
import { createDeskClient } from '../core/antigel/deskSystemd';
import { runScopeDeps } from '../core/antigel/runScopesFs';
import { readStateFileBounded } from '../core/antigel/stateFile';
import { BusctlError, createBusctl, createSystemdClient, type BusctlRun } from '../core/antigel/systemd';
import { systemBin } from '../core/childEnv';
import type { RecorderDeps } from './recorder';

const DESK_FILES: ReadonlySet<DeskFile> = new Set<DeskFile>(['cgroup.controllers', 'cgroup.subtree_control', 'cpu.weight', 'io.weight', 'memory.low', 'memory.min']);

/** Fichier de contrôle d'un cgroup (lecture seule) : chemin absolu sans « . » ni « .. », fichier de la liste ; null sinon. */
export function readDeskFile(sysfsRoot: string, cgroup: string, file: DeskFile): string | null {
  if (!DESK_FILES.has(file) || !cgroup.startsWith('/') || cgroup.includes('\0') || cgroup.split('/').some((x) => x === '..' || x === '.')) return null;
  try {
    return readFileSync(join(sysfsRoot, cgroup, file), 'utf8').slice(0, 4096);
  } catch {
    return null;
  }
}

/** Origines du bureau prioritaire (antigel-desk.json, 0600) : relues bornées, sans lien symbolique ; écrites par renommage. */
export const antigelDeskPath = (dataDir: string) => join(dataDir, 'antigel-desk.json');
export function loadDeskOriginals(dataDir: string): DeskOriginals {
  try {
    const text = readStateFileBounded(antigelDeskPath(dataDir));
    const o = text === null ? null : (JSON.parse(text) as { version?: unknown; units?: unknown });
    return o && o.version === 1 ? sanitizeOriginals(o.units) : {};
  } catch {
    return {};
  }
}
export function saveDeskOriginals(dataDir: string, units: DeskOriginals): void {
  const p = antigelDeskPath(dataDir);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, units }), { mode: 0o600 });
  renameSync(tmp, p);
}

export function antigelDepsFor(o: {
  env: NodeJS.ProcessEnv; uid: number; selfPid: number; exists?: (p: string) => boolean; procRoot?: string; sysfsRoot?: string;
  /** Dossier de données (origines du bureau prioritaire) ; absent : gardées en mémoire seulement. */
  dataDir?: string;
}): RecorderDeps['antigel'] {
  if (o.env.PROC_WATCH_NO_ANTIGEL === '1') return undefined;
  const procRoot = o.procRoot ?? '/proc';
  const sysfsRoot = o.sysfsRoot ?? '/sys/fs/cgroup';
  const busctl = systemBin('busctl', o.exists ?? existsSync);
  const run: BusctlRun = busctl ? createBusctl(busctl, o.env) : async () => { throw new BusctlError('busctl introuvable', 'unreachable'); };
  const client = createSystemdClient(run);
  const dataDir = o.dataDir;
  const desk: Omit<DeskDeps, 'monoNow' | 'log'> = {
    client: createDeskClient(run),
    readCg: (cg, file) => readDeskFile(sysfsRoot, cg, file),
    loadOriginals: dataDir ? () => loadDeskOriginals(dataDir) : undefined,
    saveOriginals: dataDir ? (u) => saveDeskOriginals(dataDir, u) : undefined,
  };
  return {
    client,
    probe: () => probeAvailability({ procRoot, sysfsRoot, uid: o.uid, selfPid: o.selfPid, busctl }),
    stats: (cg) => readCgroupStats(sysfsRoot, cg),
    cgroupOf: (pid) => readCgroup(procRoot, pid),
    reverify: (targets, cg) => reverify(procRoot, o.uid, targets, cg),
    // lot 4 : scopes ouverts par `computer-watcher run` (comptés, slice attribuée ; jamais déplacés)
    run: runScopeDeps(procRoot, sysfsRoot),
    desk,
  };
}
