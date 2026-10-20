// Anti-gel : client du gestionnaire systemd UTILISATEUR par busctl. Sans shell, argv construit ici seulement, noms
// d'unités validés, PIDs et tailles bornés, délai court. Jamais le bus système, jamais d'unité hors cwatch.
import { execFile } from 'node:child_process';
import { cleanEnv } from '../childEnv';
import { INFINITY_T, type SliceLimits } from './limits';
import { TEST_SCOPE_RE, TEST_SLICE_RE, isScopeName, isSliceName } from './units';

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
  if (pids.length === 0 || pids.length > MAX_PIDS || !pids.every((p) => Number.isInteger(p) && p > 1 && p <= PID_MAX)) throw new Error('PIDs refusés');
  return [String(pids.length), ...pids.map(String)];
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

export function startScopeArgv(scope: string, slice: string, pids: number[], memoryHighBytes: number | null): string[] {
  const props = [
    ['PIDs', 'au', ...pidList(pids)],
    ['Slice', 's', unit(slice, isSliceName)],
    ['OOMPolicy', 's', 'continue'],
    ['Description', 's', DESCRIPTION],
    ...(memoryHighBytes === null ? [] : [['MemoryHigh', 't', bytes(memoryHighBytes)]]),
  ];
  return [...head('StartTransientUnit', 'ssa(sv)a(sa(sv))'), unit(scope, isScopeName), 'fail', String(props.length), ...props.flat(), '0'];
}

export function attachArgv(scope: string, pids: number[]): string[] {
  return [...head('AttachProcessesToUnit', 'ssau'), unit(scope, isScopeName), '', ...pidList(pids)];
}

export function startSliceArgv(slice: string, l: SliceLimits): string[] {
  const props = [['Description', 's', DESCRIPTION], ...sliceProps(l)];
  return [...head('StartTransientUnit', 'ssa(sv)a(sa(sv))'), unit(slice, isSliceName), 'fail', String(props.length), ...props.flat(), '0'];
}

/** Plafonds de la slice (runtime : rien de persistant) ; null : remis à « infinity ». */
export function setSliceArgv(slice: string, l: SliceLimits | null): string[] {
  const props = sliceProps(l);
  return [...head('SetUnitProperties', 'sba(sv)'), unit(slice, isSliceName), 'true', String(props.length), ...props.flat()];
}

export function setScopeHighArgv(scope: string, b: number | null): string[] {
  return [...head('SetUnitProperties', 'sba(sv)'), unit(scope, isScopeName), 'true', '1', 'MemoryHigh', 't', bytes(b)];
}

/** Nettoyage de l'e2e seulement : jamais cwatch.slice ni un scope de projet. */
export function stopTestUnitArgv(name: string): string[] {
  if (!TEST_SLICE_RE.test(name) && !TEST_SCOPE_RE.test(name)) throw new Error(`arrêt refusé : ${name}`);
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
  if (/UnitExists|already exists/i.test(stderr)) return 'exists';
  if (/NoSuchUnit|not loaded|not found|not active/i.test(stderr)) return 'no-unit';
  if (/AccessDenied|Access denied|Permission denied|Operation not permitted/i.test(stderr)) return 'denied';
  if (/Failed to connect|Connection refused|Transport endpoint|No such file or directory|Connection timed out/i.test(stderr)) return 'unreachable';
  return 'other';
}

export type BusctlRun = (argv: readonly string[]) => Promise<void>;
export type ExecLike = (
  file: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
  cb: (err: (Error & { killed?: boolean }) | null, stdout: string, stderr: string) => void,
) => unknown;

/** busctl par son chemin absolu (systemBin), execFile sans shell, environnement nettoyé (AppImage), délai borné. */
export function createBusctl(bin: string, env: NodeJS.ProcessEnv = process.env, exec: ExecLike = execFile as unknown as ExecLike): BusctlRun {
  if (!bin.startsWith('/')) throw new Error(`busctl : chemin absolu attendu (${bin})`);
  const e = cleanEnv(env);
  return (argv) =>
    new Promise<void>((resolve, reject) => {
      exec(bin, [...argv], { env: e, timeout: (BUSCTL_TIMEOUT_S + 2) * 1000, maxBuffer: 64 * 1024 }, (err, _out, stderr) => {
        if (!err) return resolve();
        const text = String(stderr ?? '');
        const msg = (text.trim() || err.message).split('\n')[0]!.slice(0, 300);
        reject(new BusctlError(msg, classifyBusctlError(text, err.killed === true)));
      });
    });
}

export interface SystemdClient {
  /** Crée la slice avec ses plafonds ; si elle existe déjà, pose les plafonds (SetUnitProperties). */
  ensureSlice(slice: string, l: SliceLimits): Promise<void>;
  /** Plafonds de la slice ; null : remis à « infinity » (interrupteur éteint). */
  setSlice(slice: string, l: SliceLimits | null): Promise<void>;
  startScope(scope: string, slice: string, pids: number[], memoryHighBytes: number | null): Promise<void>;
  attach(scope: string, pids: number[]): Promise<void>;
  setScopeHigh(scope: string, bytes: number | null): Promise<void>;
  /** e2e seulement (unités cwatch-e2e… / cwatch-p-e2e…). */
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
  return {
    async ensureSlice(slice, l) {
      try {
        await call(() => startSliceArgv(slice, l));
      } catch (e) {
        if (!(e instanceof BusctlError && e.code === 'exists')) throw e;
        await call(() => setSliceArgv(slice, l));
      }
    },
    setSlice: (slice, l) => call(() => setSliceArgv(slice, l)),
    startScope: (scope, slice, pids, h) => call(() => startScopeArgv(scope, slice, pids, h)),
    attach: (scope, pids) => call(() => attachArgv(scope, pids)),
    setScopeHigh: (scope, b) => call(() => setScopeHighArgv(scope, b)),
    stopTestUnit: (name) => call(() => stopTestUnitArgv(name)),
    calls: () => n,
  };
}
