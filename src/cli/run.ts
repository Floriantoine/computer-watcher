// `computer-watcher run [--mem 6G] -- <commande>` (anti-gel, lot 4) : orchestration, dépendances injectées.
//
// 1. Arguments, puis résolution de la commande (PATH de la commande) : une commande introuvable ne crée aucune unité.
// 2. Plafond de travail actif (cwatch.slice plafonnée dans /sys, gestionnaire utilisateur joignable) : le lanceur se
//    déplace lui-même dans un scope neuf (StartTransientUnit, PIDs = son PID) sous la slice du projet du dossier courant,
//    et attend de se voir dans ce cgroup.
// 3. Remplacement par la commande (execve) : même PID, terminal, entrée/sorties, signaux et code de sortie natifs.
// Toute impossibilité à l'étape 2 (éteint, indisponible, refus, délai) : avertissement sur stderr et commande lancée
// quand même, sans plafond. Jamais de shell, jamais d'unité hors cwatch.slice (ou de la slice de test).
import { isAbsolute, resolve as resolvePath } from 'node:path';
import type { Availability, CgroupStats } from '../core/antigel/cgroupfs';
import {
  USAGE, commandEnv, parseRunArgs, runProjectSlice, runRootSlice, runScopeN, runScopeName, startRunScopeArgv, workRoot,
} from '../core/antigel/run';
import { BusctlError, type BusctlRun } from '../core/antigel/systemd';
import { scopePath, slicePath } from '../core/antigel/units';

/** Attente maximale du déplacement du lanceur dans son scope (le job systemd part juste après la réponse de busctl). */
export const CONFIRM_TIMEOUT_MS = 3000;
const POLL_MS = 10;

export type ResolvedCommand = { file: string; argv: string[] };
export type ResolveError = { code: 126 | 127; message: string };

export interface CliDeps {
  env: NodeJS.ProcessEnv;
  /** Dossier courant ; null s'il a été supprimé (aucun projet, aucun chemin relatif). */
  cwd: string | null;
  home: string;
  pid: number;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  /** cgroups v2, gestionnaire systemd de l'utilisateur, contrôleur memory délégué, busctl (lot 1). */
  probe: () => Availability;
  /** Mémoire d'un cgroup (« /user.slice/… »), null s'il n'existe pas. */
  stats: (cgroupPath: string) => CgroupStats | null;
  findRoot: (cwd: string) => string | null;
  /** Attribution slice de projet → racine relue dans antigel-state.json (vide si illisible). */
  attribution: () => ReadonlyMap<string, string | null>;
  busctl: BusctlRun | null;
  selfCgroup: () => string | null;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  resolve: (command: readonly string[], env: NodeJS.ProcessEnv, cwd: string | null) => ResolvedCommand | ResolveError;
  /** Remplace le processus (execve : ne rend jamais la main) ; repli sans execve : code de sortie de la commande. */
  exec: (file: string, argv: string[], env: NodeJS.ProcessEnv) => Promise<number>;
}

const isCapped = (s: CgroupStats | null) => s !== null && (s.highBytes !== null || s.maxBytes !== null);

/** Déplace le lanceur dans un scope « run ». null : fait ; sinon la raison (avertissement). */
async function enterScope(d: CliDeps, memBytes: number | null): Promise<string | null> {
  if (d.env.PROC_WATCH_NO_ANTIGEL === '1') return 'plafond de travail coupé (PROC_WATCH_NO_ANTIGEL=1)';
  const rootSlice = runRootSlice(d.env);
  if ('error' in rootSlice) throw new UsageError(rootSlice.error);
  const avail = d.probe();
  if (!avail.ok) return `plafond de travail indisponible : ${avail.reason}`;
  const cg = (slice: string) => `${avail.userBase}/${slicePath(slice)}`;
  if (!isCapped(d.stats(cg(rootSlice.slice)))) return `plafond de travail éteint (${rootSlice.slice} sans plafond)`;
  if (!d.busctl) return 'busctl introuvable';
  const slice = runProjectSlice({
    root: d.cwd === null ? null : workRoot(d.cwd, d.findRoot, d.home),
    taken: rootSlice.test ? new Map() : d.attribution(),
    test: rootSlice.test ? rootSlice.slice : null,
  });
  let scope = '';
  for (let attempt = 0; ; attempt++) {
    // horloge murale pour le nom (performance.now() vaut à peu près pareil à chaque lancement)
    scope = runScopeName(slice, runScopeN(d.pid, Date.now(), attempt));
    try {
      await d.busctl(startRunScopeArgv(scope, slice, d.pid, memBytes));
      break;
    } catch (e) {
      if (e instanceof BusctlError && e.code === 'exists' && attempt === 0) continue;
      return `plafond de travail non posé : ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const want = `${avail.userBase}/${scopePath(scope, slice)}`;
  const start = d.now();
  while (d.selfCgroup() !== want) {
    if (d.now() - start >= CONFIRM_TIMEOUT_MS) return `déplacement dans ${scope} non confirmé`;
    await d.sleep(POLL_MS);
  }
  return null;
}

class UsageError extends Error {}

export async function runCli(args: readonly string[], d: CliDeps): Promise<number> {
  const parsed = parseRunArgs(args);
  if (parsed.kind === 'help') {
    d.stdout(USAGE);
    return 0;
  }
  const usage = (message: string) => {
    d.stderr(`computer-watcher run : ${message}\nAide : computer-watcher run --help\n`);
    return 2;
  };
  if (parsed.kind === 'error') return usage(parsed.message);
  const env = commandEnv(d.env);
  const cmd = d.resolve(parsed.command, env, d.cwd);
  if ('code' in cmd) {
    d.stderr(`computer-watcher run : ${cmd.message}\n`);
    return cmd.code;
  }
  let warning: string | null;
  try {
    warning = await enterScope(d, parsed.memBytes);
  } catch (e) {
    if (e instanceof UsageError) return usage(e.message);
    warning = `plafond de travail non posé : ${e instanceof Error ? e.message : String(e)}`;
  }
  if (warning !== null) d.stderr(`computer-watcher : ${warning} ; commande lancée sans plafond${parsed.memBytes !== null ? ' (--mem ignoré)' : ''}.\n`);
  return d.exec(cmd.file, cmd.argv, env);
}

/** Accès au système de fichiers pour resolveCommand (suit les liens, comme execve). */
export interface FsLike {
  kind: (p: string) => 'file' | 'dir' | 'other' | null;
  executable: (p: string) => boolean;
  /** Premiers octets (au plus HEAD_BYTES ; null : illisible, comme un exécutable en exécution seule). */
  head: (p: string) => Buffer | null;
}

const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin';
/** Octets lus en tête d'un exécutable (ligne « #! » comprise : le noyau en lit 256 au plus). */
export const HEAD_BYTES = 256;

/**
 * Comme execvp, mais vérifié AVANT l'exec (un execve raté abat le processus Node) : commande avec « / » relative au
 * dossier courant, sinon recherche dans le PATH de la commande (entrée vide : dossier courant). Introuvable : 127 ;
 * trouvé mais non exécutable : 126. Script « #! » : son interpréteur doit exister et être exécutable (sinon 127 / 126).
 * ELF, binaire (octet nul : binfmt_misc…) ou en-tête illisible (exécution seule) : exec direct. Texte sans « #! » :
 * /bin/sh <fichier>, comme execvp.
 */
export function resolveCommand(command: readonly string[], env: NodeJS.ProcessEnv, cwd: string | null, fs: FsLike): ResolvedCommand | ResolveError {
  const [name, ...rest] = command;
  if (!name) return { code: 127, message: 'commande manquante' };
  // dossier courant supprimé : seuls les chemins absolus restent valables
  const at = (...p: string[]): string[] => (cwd !== null ? [resolvePath(cwd, ...p)] : isAbsolute(p[0]!) ? [resolvePath(...p)] : []);
  const candidates = name.includes('/') ? at(name) : (env.PATH ?? DEFAULT_PATH).split(':').flatMap((dir) => at(dir || '.', name));
  let denied: string | null = null;
  for (const p of candidates) {
    const k = fs.kind(p);
    if (k === null) continue;
    if (k !== 'file' || !fs.executable(p)) {
      denied ??= p;
      continue;
    }
    const h = fs.head(p);
    const direct = { file: p, argv: [name, ...rest] };
    if (h === null || h.includes(0) || (h[0] === 0x7f && h.subarray(1, 4).toString('latin1') === 'ELF')) return direct;
    if (h[0] === 0x23 && h[1] === 0x21) {
      const line = h.subarray(2).toString('latin1').split('\n', 1)[0]!.trim();
      const interp = line.split(/[ \t]/, 1)[0] ?? '';
      const ip = interp === '' ? null : isAbsolute(interp) ? interp : cwd !== null ? resolvePath(cwd, interp) : null;
      const k2 = ip === null ? null : fs.kind(ip);
      if (ip === null || k2 === null) return { code: 127, message: `interpréteur introuvable pour ${p} : ${interp || '(vide)'}` };
      if (k2 !== 'file' || !fs.executable(ip)) return { code: 126, message: `interpréteur non exécutable pour ${p} : ${ip}` };
      return direct;
    }
    return { file: '/bin/sh', argv: ['/bin/sh', p, ...rest] };
  }
  return denied !== null ? { code: 126, message: `permission refusée : ${denied}` } : { code: 127, message: `commande introuvable : ${name}` };
}
