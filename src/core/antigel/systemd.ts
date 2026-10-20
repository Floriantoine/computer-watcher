// Anti-gel : client du gestionnaire systemd UTILISATEUR par busctl. Sans shell, argv construit ici seulement, noms
// d'unités validés, PIDs et tailles bornés, délai court. Jamais le bus système, jamais d'unité hors cwatch.
import { execFile } from 'node:child_process';
import { cleanEnv } from '../childEnv';
import { INFINITY_T, type SliceLimits } from './limits';
import { isProjectSliceName, isRootSliceName, isScopeName, isTestUnitName, scopeBelongs } from './units';

const DEST = 'org.freedesktop.systemd1';
const OBJ = '/org/freedesktop/systemd1';
const IFACE = 'org.freedesktop.systemd1.Manager';
export const BUSCTL_TIMEOUT_S = 5;
export const MAX_PIDS = 256;
const PID_MAX = 4_194_304;
export const DESCRIPTION = 'Computer Watcher anti-gel';

const head = (method: string, sig: string) => ['--user', `--timeout=${BUSCTL_TIMEOUT_S}`, 'call', DEST, OBJ, IFACE, method, sig];

function unit(name: string, ok: (s: unknown) => boolean): string {
  if (!ok(name)) throw new Error(`unité refusée : ${name}`);
  return name;
}
function pidList(pids: readonly number[]): string[] {
  if (!pids.every((p) => Number.isInteger(p) && p > 1 && p <= PID_MAX)) throw new Error('PIDs refusés');
  const uniq = [...new Set(pids)];
  if (uniq.length === 0 || uniq.length > MAX_PIDS) throw new Error('PIDs refusés');
  return [String(uniq.length), ...uniq.map(String)];
}
/** Taille en octets (> 0), ou null : « infinity ». */
function bytes(n: number | null): string {
  if (n === null) return INFINITY_T;
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`taille refusée : ${n}`);
  return String(n);
}
function swapBytes(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`taille de swap refusée : ${n}`);
  return String(n);
}
const sliceProps = (l: SliceLimits | null): string[][] => [
  ['MemoryHigh', 't', bytes(l ? l.highBytes : null)],
  ['MemoryMax', 't', bytes(l ? l.maxBytes : null)],
  ['MemorySwapMax', 't', l ? swapBytes(l.swapMaxBytes) : INFINITY_T],
];

/** Scope neuf d'un lot de déplacement : PIDs, Slice, OOMPolicy=continue, Description ; aucune limite propre. */
export function startScopeArgv(scope: string, projectSlice: string, pids: number[]): string[] {
  unit(scope, isScopeName);
  unit(projectSlice, isProjectSliceName);
  if (!scopeBelongs(scope, projectSlice)) throw new Error(`scope refusé pour ${projectSlice} : ${scope}`);
  const props = [['PIDs', 'au', ...pidList(pids)], ['Slice', 's', projectSlice], ['OOMPolicy', 's', 'continue'], ['Description', 's', DESCRIPTION]];
  return [...head('StartTransientUnit', 'ssa(sv)a(sa(sv))'), scope, 'fail', String(props.length), ...props.flat(), '0'];
}

/** Slice racine (cwatch.slice ou slice de test) : seule porteuse de MemoryMax / MemorySwapMax. */
export function startSliceArgv(slice: string, l: SliceLimits): string[] {
  const props = [['Description', 's', DESCRIPTION], ...sliceProps(l)];
  return [...head('StartTransientUnit', 'ssa(sv)a(sa(sv))'), unit(slice, isRootSliceName), 'fail', String(props.length), ...props.flat(), '0'];
}

/** Plafonds de la slice racine (runtime : rien de persistant) ; null : remis à « infinity ». */
export function setSliceArgv(slice: string, l: SliceLimits | null): string[] {
  const props = sliceProps(l);
  return [...head('SetUnitProperties', 'sba(sv)'), unit(slice, isRootSliceName), 'true', String(props.length), ...props.flat()];
}

/** Slice d'un projet : seulement le budget MemoryHigh (null : infinity). */
export function startProjectSliceArgv(slice: string, highBytes: number | null): string[] {
  const props = [['Description', 's', DESCRIPTION], ['MemoryHigh', 't', bytes(highBytes)]];
  return [...head('StartTransientUnit', 'ssa(sv)a(sa(sv))'), unit(slice, isProjectSliceName), 'fail', String(props.length), ...props.flat(), '0'];
}

export function setProjectHighArgv(slice: string, highBytes: number | null): string[] {
  return [...head('SetUnitProperties', 'sba(sv)'), unit(slice, isProjectSliceName), 'true', '1', 'MemoryHigh', 't', bytes(highBytes)];
}

/** Nettoyage de l'e2e seulement : jamais cwatch.slice, une slice de projet ni un scope de projet. */
export function stopTestUnitArgv(name: string): string[] {
  if (!isTestUnitName(name)) throw new Error(`arrêt refusé : ${name}`);
  return [...head('StopUnit', 'ss'), name, 'replace'];
}

export type BusctlErrorCode = 'exists' | 'no-unit' | 'denied' | 'unreachable' | 'timeout' | 'other';
export class BusctlError extends Error {
  constructor(message: string, readonly code: BusctlErrorCode) {
    super(message);
  }
}

export function classifyBusctlError(stderr: string, killed = false): BusctlErrorCode {
  if (killed) return 'timeout';
  if (/UnitExists|was already loaded or has a fragment file/i.test(stderr)) return 'exists';
  if (/NoSuchUnit|Unit \S+ not (found|loaded)|not active/i.test(stderr)) return 'no-unit';
  if (/AccessDenied|Access denied|Permission denied|Operation not permitted/i.test(stderr)) return 'denied';
  if (/Failed to connect|Connection refused|Transport endpoint/i.test(stderr)) return 'unreachable';
  if (/timed out|Timeout was reached/i.test(stderr)) return 'timeout';
  return 'other';
}

export type BusctlRun = (argv: readonly string[]) => Promise<void>;
export type ExecLike = (
  file: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
  cb: (err: (Error & { killed?: boolean; code?: unknown }) | null, stdout: string, stderr: string) => void,
) => unknown;

const BUSCTL_PATHS = ['/usr/bin/busctl', '/bin/busctl'];
const ARGV_PREFIX = ['--user', `--timeout=${BUSCTL_TIMEOUT_S}`];

/** busctl par son chemin absolu (systemBin), execFile sans shell, environnement nettoyé (AppImage), délai borné. */
export function createBusctl(bin: string, env: NodeJS.ProcessEnv = process.env, exec: ExecLike = execFile as unknown as ExecLike): BusctlRun {
  if (!BUSCTL_PATHS.includes(bin)) throw new Error(`busctl : chemin refusé (${bin})`);
  const e = cleanEnv(env);
  return (argv) =>
    new Promise<void>((resolve, reject) => {
      if (!ARGV_PREFIX.every((a, i) => argv[i] === a)) return reject(new Error('busctl : argv refusé (--user --timeout=5 attendus en tête)'));
      exec(bin, [...argv], { env: e, timeout: (BUSCTL_TIMEOUT_S + 2) * 1000, maxBuffer: 64 * 1024 }, (err, _out, stderr) => {
        if (!err) return resolve();
        const text = String(stderr ?? '');
        const msg = (text.trim() || err.message).split('\n')[0]!.slice(0, 300);
        const code = err.code === 'ENOENT' ? 'unreachable' : classifyBusctlError(text, err.killed === true);
        reject(new BusctlError(msg, code));
      });
    });
}

export interface SystemdClient {
  /** Slice racine (cwatch.slice ou slice de test) avec ses plafonds ; si elle existe déjà, pose les plafonds. */
  ensureSlice(slice: string, l: SliceLimits): Promise<void>;
  /** Plafonds de la slice racine ; null : remis à « infinity » (interrupteur éteint). */
  setSlice(slice: string, l: SliceLimits | null): Promise<void>;
  /** Slice d'un projet avec son budget MemoryHigh (null : infinity) ; si elle existe déjà, pose le budget. */
  ensureProjectSlice(slice: string, highBytes: number | null): Promise<void>;
  /** Budget MemoryHigh de la slice d'un projet (null : infinity). */
  setProjectHigh(slice: string, highBytes: number | null): Promise<void>;
  /** Scope neuf (OOMPolicy=continue, aucune limite) sous la slice de projet, avec ces PIDs. */
  startScope(scope: string, projectSlice: string, pids: number[]): Promise<void>;
  /** e2e seulement (unités cwatch-e2e…). */
  stopTestUnit(name: string): Promise<void>;
  /** Appels busctl lancés depuis la création. */
  calls(): number;
}

export function createSystemdClient(run: BusctlRun): SystemdClient {
  let n = 0;
  // l'argv est construit (et validé) AVANT de compter l'appel : un nom refusé ne lance rien
  const call = async (build: () => string[]) => {
    const argv = build();
    n++;
    await run(argv);
  };
  // crée l'unité ; si systemd la connaît déjà, pose les propriétés
  const ensure = async (start: () => string[], set: () => string[]) => {
    try {
      await call(start);
    } catch (e) {
      if (!(e instanceof BusctlError && e.code === 'exists')) throw e;
      await call(set);
    }
  };
  return {
    ensureSlice: (slice, l) => ensure(() => startSliceArgv(slice, l), () => setSliceArgv(slice, l)),
    setSlice: (slice, l) => call(() => setSliceArgv(slice, l)),
    ensureProjectSlice: (slice, h) => ensure(() => startProjectSliceArgv(slice, h), () => setProjectHighArgv(slice, h)),
    setProjectHigh: (slice, h) => call(() => setProjectHighArgv(slice, h)),
    startScope: (scope, slice, pids) => call(() => startScopeArgv(scope, slice, pids)),
    stopTestUnit: (name) => call(() => stopTestUnitArgv(name)),
    calls: () => n,
  };
}
