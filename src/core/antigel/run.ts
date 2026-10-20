// Anti-gel (lot 4) : `computer-watcher run [--mem 6G] -- <commande>`, décisions pures (arguments, noms, argv busctl figé,
// slice du projet, environnement de la commande). L'exécution est dans src/cli/run.ts.
//
// Le lanceur se déplace lui-même (PIDs = son propre PID) dans un scope neuf par StartTransientUnit, puis remplace son image
// par la commande (execve) : la commande garde son PID, son terminal, son entrée, ses signaux et son code de sortie.
import { cleanEnv } from '../childEnv';
import { BUDGET_MAX_MB, BUDGET_MIN_MB } from './config';
import { MiB } from './limits';
import { BUSCTL_TIMEOUT_S, DESCRIPTION } from './systemd';
import { OTHERS_KEY, ROOT_SLICE, TEST_SLICE_RE, isProjectSliceName, isScopeName, newScopeName, projectSliceFor, scopeBelongs, shortHash } from './units';

export const RUN_DESCRIPTION = `${DESCRIPTION} (computer-watcher run)`;
export const MEM_MIN_BYTES = BUDGET_MIN_MB * MiB;
export const MEM_MAX_BYTES = BUDGET_MAX_MB * MiB;
const PID_MAX = 4_194_304;

export const USAGE = `Usage : computer-watcher run [--mem <taille>] [--] <commande> [arguments…]

Lance <commande> sous le plafond de travail (cwatch.slice), dans la slice du projet du dossier courant
(« autres » hors projet), dans un scope dédié. Entrée, sorties, terminal, signaux et code de sortie
sont ceux de la commande.

Options :
  --mem <taille>  budget mémoire de la commande (MemoryHigh de son scope) : un entier suivi de K, M ou G
                  (puissances de 1024), de 256M à 1024G. Exemple : --mem 6G
  -h, --help      affiche cette aide

Plafond de travail éteint ou indisponible : la commande est lancée quand même, sans plafond, avec un
avertissement sur la sortie d'erreur.
`;

const UNITS: Record<string, number> = { K: 1024, M: MiB, G: 1024 * MiB };

/** Taille de --mem : entier sans zéro de tête suivi de K, M ou G (casse indifférente), bornée ; null : refusée. */
export function parseMem(s: string): number | null {
  const m = /^([1-9][0-9]{0,9})([KMG])$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]) * UNITS[m[2]!.toUpperCase()]!;
  return Number.isSafeInteger(n) && n >= MEM_MIN_BYTES && n <= MEM_MAX_BYTES ? n : null;
}

export type RunArgs = { kind: 'help' } | { kind: 'run'; memBytes: number | null; command: string[] } | { kind: 'error'; message: string };

/**
 * Arguments après « run ». Les options s'arrêtent à « -- » ou au premier argument qui n'est pas une option : tout ce qui
 * suit appartient à la commande, tel quel.
 */
export function parseRunArgs(args: readonly string[]): RunArgs {
  let mem: number | null = null;
  let seenMem = false;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      i++;
      break;
    }
    if (a === '-h' || a === '--help') return { kind: 'help' };
    if (a === '--mem' || a.startsWith('--mem=')) {
      if (seenMem) return { kind: 'error', message: '--mem donné deux fois' };
      seenMem = true;
      const v = a === '--mem' ? args[++i] : a.slice('--mem='.length);
      if (v === undefined) return { kind: 'error', message: '--mem : taille manquante' };
      mem = parseMem(v);
      if (mem === null) return { kind: 'error', message: `--mem : taille refusée (${v}) ; un entier suivi de K, M ou G, de 256M à 1024G` };
      continue;
    }
    if (a.startsWith('-') && a !== '-') return { kind: 'error', message: `option inconnue : ${a}` };
    break;
  }
  const command = args.slice(i);
  if (command.length === 0) return { kind: 'error', message: 'commande manquante' };
  if (command[0] === '') return { kind: 'error', message: 'commande vide' };
  return { kind: 'run', memBytes: mem, command: [...command] };
}

const b36 = (n: number, w: number) => n.toString(36).padStart(w, '0').slice(-w);

/** `<n>` d'un scope « run » : « r » + PID (5) + horloge (5), base 36 ; 11 caractères, jamais les 12 des scopes du contrôleur. */
export function runScopeN(pid: number, nowMs: number, attempt: number): string {
  if (!Number.isInteger(pid) || pid <= 1 || pid > PID_MAX) throw new Error(`PID refusé : ${pid}`);
  const t = Math.floor(nowMs) + attempt;
  return `r${b36(pid, 5)}${b36(Number.isSafeInteger(t) && t >= 0 ? t : 0, 5)}`;
}

const RUN_N_RE = /-r[a-z0-9]{10}\.scope$/;
/** Scope ouvert par `computer-watcher run` (production ou test). */
export const isRunScopeName = (s: unknown): s is string => isScopeName(s) && RUN_N_RE.test(s);

export function runScopeName(projectSlice: string, n: string): string {
  const s = newScopeName(projectSlice, n);
  if (!isRunScopeName(s)) throw new Error(`scope refusé : ${s}`);
  return s;
}

/**
 * StartTransientUnit du scope « run » : le lanceur seul (ses futurs enfants suivent), sous la slice du projet,
 * OOMPolicy=continue, CollectMode=inactive-or-failed, Description ; MemoryHigh seulement avec --mem. Jamais MemoryMax.
 */
export function startRunScopeArgv(scope: string, projectSlice: string, pid: number, memHighBytes: number | null): string[] {
  if (!isRunScopeName(scope)) throw new Error(`unité refusée : ${scope}`);
  if (!isProjectSliceName(projectSlice) || !scopeBelongs(scope, projectSlice)) throw new Error(`scope refusé pour ${projectSlice} : ${scope}`);
  if (!Number.isInteger(pid) || pid <= 1 || pid > PID_MAX) throw new Error('PID refusé');
  if (memHighBytes !== null && !(Number.isSafeInteger(memHighBytes) && memHighBytes >= MEM_MIN_BYTES && memHighBytes <= MEM_MAX_BYTES)) {
    throw new Error(`taille refusée : ${memHighBytes}`);
  }
  const props = [
    ['PIDs', 'au', '1', String(pid)], ['Slice', 's', projectSlice], ['OOMPolicy', 's', 'continue'], ['CollectMode', 's', 'inactive-or-failed'],
    ['Description', 's', RUN_DESCRIPTION],
    ...(memHighBytes === null ? [] : [['MemoryHigh', 't', String(memHighBytes)]]),
  ];
  return [
    '--user', `--timeout=${BUSCTL_TIMEOUT_S}`, 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager',
    'StartTransientUnit', 'ssa(sv)a(sa(sv))', scope, 'fail', String(props.length), ...props.flat(), '0',
  ];
}

/** Slice racine : cwatch.slice, ou (tests de bout en bout) une slice de test donnée par PROC_WATCH_RUN_ROOT_SLICE. */
export function runRootSlice(env: NodeJS.ProcessEnv): { slice: string; test: boolean } | { error: string } {
  const v = env.PROC_WATCH_RUN_ROOT_SLICE;
  if (v === undefined || v === '') return { slice: ROOT_SLICE, test: false };
  if (!TEST_SLICE_RE.test(v)) return { error: `PROC_WATCH_RUN_ROOT_SLICE refusée (slice de test cwatch-e2e… attendue) : ${v.slice(0, 80)}` };
  return { slice: v, test: true };
}

const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/** Racine du projet du dossier courant, comme le contrôleur (groupes `project:`) : jamais « / » ni le dossier personnel. */
export function workRoot(cwd: string, findRoot: (cwd: string) => string | null, home: string): string | null {
  const r = findRoot(cwd);
  if (r === null || trim(r) === '/' || trim(r) === trim(home)) return null;
  return r;
}

/**
 * Slice du projet. Production : attribution relue (antigel-state.json, slice → racine) et même règle que le contrôleur ;
 * une slice déjà là sans attribution n'est jamais réutilisée (nom haché ; haché aussi là : « autres »).
 * Test : cwatch-e2e<id>-autres.slice ou cwatch-e2e<id>-p<hachage>.slice.
 */
export function runProjectSlice(i: {
  root: string | null; taken: ReadonlyMap<string, string | null>; present: (slice: string) => boolean; test: string | null;
}): string {
  if (i.test !== null) {
    const base = i.test.slice(0, -'.slice'.length);
    return `${base}-${i.root === null ? OTHERS_KEY : `p${shortHash(i.root)}`}.slice`;
  }
  const others = projectSliceFor(null, i.taken);
  if (i.root === null) return others;
  const usable = (s: string) => i.taken.get(s) === i.root || (!i.taken.has(s) && !i.present(s));
  const s = projectSliceFor(i.root, i.taken);
  if (usable(s)) return s;
  const h = projectSliceFor(i.root, new Map([...i.taken, [s, null]]));
  return h !== s && usable(h) ? h : others;
}

/** Environnement de la commande : sans le runtime AppImage (cleanEnv), sans le mode Node d'Electron ni la variable de test. */
export function commandEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = cleanEnv(env);
  delete out.ELECTRON_RUN_AS_NODE;
  delete out.PROC_WATCH_RUN_ROOT_SLICE;
  // posée par Electron au démarrage de l'app (absente de l'environnement d'origine)
  if (out.CHROME_DESKTOP !== undefined && /^(electron|computer-watcher)\.desktop$/.test(out.CHROME_DESKTOP)) delete out.CHROME_DESKTOP;
  return out;
}
