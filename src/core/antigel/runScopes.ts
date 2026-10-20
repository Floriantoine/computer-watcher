// Anti-gel (lot 4) : scopes ouverts par `computer-watcher run`, vus par le contrôleur du service. Il ne les déplace jamais
// (ils sont déjà sous cwatch.slice) ; il compte leurs processus et attribue leur slice de projet quand il ne la connaît pas.
import type { ProcInfo } from '../types';
import { isRunScopeName } from './run';
import { OTHERS_SLICE } from './units';

/** Recul avant de réexaminer une slice inconnue dont la racine n'a pas été trouvée. */
export const RUN_RETRY_MS = 60_000;
/** Processus examinés au plus pour retrouver la racine d'une slice (les plus anciens d'abord). */
const MAX_CWD_READS = 8;
/** Scopes « run » lus au plus par slice et par tick. */
const MAX_RUN_SCOPES = 64;

export interface RunScopeDeps {
  /** Noms des entrées d'un dossier de cgroup (« /user.slice/… ») ; null s'il n'existe pas. */
  listDir: (cgroupPath: string) => string[] | null;
  /** PIDs d'un cgroup (cgroup.procs) ; null s'il n'existe pas. */
  procsOf: (cgroupPath: string) => number[] | null;
  /** Dossier courant d'un processus (lien /proc/<pid>/cwd) ; null si illisible ou supprimé. */
  cwdOf: (pid: number) => string | null;
}

/** PIDs des scopes « run » d'une slice de projet. */
export function runPidsOf(sliceCgroup: string, d: RunScopeDeps): Set<number> {
  const out = new Set<number>();
  const scopes = (d.listDir(sliceCgroup) ?? []).filter(isRunScopeName).slice(0, MAX_RUN_SCOPES);
  for (const s of scopes) for (const pid of d.procsOf(`${sliceCgroup}/${s}`) ?? []) out.add(pid);
  return out;
}

const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/**
 * Racine d'une slice inconnue qui contient des scopes « run » : « autres » → null ; sinon la racine de projet du dossier
 * courant d'un de ses processus (les plus anciens d'abord : le lanceur, devenu la commande), retenue seulement si ce nom
 * de slice a pu être donné à cette racine (`plausible`). undefined : aucune (pas de scope « run », racine introuvable).
 */
export function runSliceRoot(
  slice: string, sliceCgroup: string, d: RunScopeDeps, byPid: ReadonlyMap<number, ProcInfo>,
  projectRootOf: ((cwd: string) => string | null) | undefined, home: string, plausible: (slice: string, root: string | null) => boolean,
): string | null | undefined {
  const pids = runPidsOf(sliceCgroup, d);
  if (pids.size === 0) return undefined;
  if (slice === OTHERS_SLICE) return null;
  if (!projectRootOf) return undefined;
  const procs = [...pids].map((pid) => byPid.get(pid)).filter((p): p is ProcInfo => p !== undefined).sort((a, b) => a.startTicks - b.startTicks);
  for (const p of procs.slice(0, MAX_CWD_READS)) {
    if (p.cwdDeleted) continue;
    const cwd = p.cwd ?? d.cwdOf(p.pid);
    if (cwd === null) continue;
    const r = projectRootOf(cwd);
    if (r === null || trim(r) === '/' || trim(r) === trim(home)) continue;
    if (plausible(slice, r)) return r;
  }
  return undefined;
}
