// Anti-gel (lot 3, « mettre au frigo ») : FreezeUnit / ThawUnit du gestionnaire systemd UTILISATEUR sur la slice d'un
// projet. Mêmes garde-fous que systemd.ts : busctl par chemin absolu, sans shell, argv construit ici seulement, nom de slice
// de projet validé (cwatch-p-<clé>.slice, ou slice de projet de test pour l'e2e), environnement nettoyé, délai court.
// Jamais cwatch.slice, jamais une unité hors cwatch.
import { execFileSync } from 'node:child_process';
import { cleanEnv } from '../childEnv';
import { BUSCTL_TIMEOUT_S, BusctlError, classifyBusctlError, type BusctlRun } from './systemd';
import { isProjectSliceName } from './units';

const DEST = 'org.freedesktop.systemd1';
const OBJ = '/org/freedesktop/systemd1';
const IFACE = 'org.freedesktop.systemd1.Manager';
const BUSCTL_PATHS = ['/usr/bin/busctl', '/bin/busctl'];
const ARGV_PREFIX = ['--user', `--timeout=${BUSCTL_TIMEOUT_S}`];

function projectSlice(name: string): string {
  if (!isProjectSliceName(name)) throw new Error(`unité refusée : ${name}`);
  return name;
}

/** Gel récursif de la slice d'un projet (ses scopes passent « frozen-by-parent »). */
export const freezeArgv = (slice: string): string[] => [...ARGV_PREFIX, 'call', DEST, OBJ, IFACE, 'FreezeUnit', 's', projectSlice(slice)];
export const thawArgv = (slice: string): string[] => [...ARGV_PREFIX, 'call', DEST, OBJ, IFACE, 'ThawUnit', 's', projectSlice(slice)];

export type BusctlRunSync = (argv: readonly string[]) => void;
type ExecSyncLike = (file: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; stdio: ['ignore', 'pipe', 'pipe'] }) => unknown;

/**
 * busctl synchrone (arrêt du service seulement : dégel avant de quitter). Même chemin absolu, même argv vérifié, délai de
 * 7 s ; lève une BusctlError classée comme la version asynchrone.
 */
export function createBusctlSync(bin: string, env: NodeJS.ProcessEnv = process.env, exec: ExecSyncLike = execFileSync as unknown as ExecSyncLike): BusctlRunSync {
  if (!BUSCTL_PATHS.includes(bin)) throw new Error(`busctl : chemin refusé (${bin})`);
  const e = cleanEnv(env);
  return (argv) => {
    if (!ARGV_PREFIX.every((a, i) => argv[i] === a)) throw new Error('busctl : argv refusé (--user --timeout=5 attendus en tête)');
    try {
      exec(bin, [...argv], { env: e, timeout: (BUSCTL_TIMEOUT_S + 2) * 1000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      const x = err as Error & { stderr?: unknown; code?: unknown; signal?: unknown };
      const text = x.stderr === undefined ? '' : String(x.stderr);
      const msg = (text.trim() || x.message).split('\n')[0]!.slice(0, 300);
      const code = x.code === 'ENOENT' ? 'unreachable' : x.code === 'ETIMEDOUT' || x.signal === 'SIGTERM' ? 'timeout' : classifyBusctlError(text);
      throw new BusctlError(msg, code);
    }
  };
}

export interface FridgeClient {
  freeze(slice: string): Promise<void>;
  thaw(slice: string): Promise<void>;
  /** Dégel synchrone (arrêt du service). */
  thawSync(slice: string): void;
  calls(): number;
}

export function createFridgeClient(run: BusctlRun, runSync: BusctlRunSync): FridgeClient {
  let n = 0;
  // argv construit (et validé) avant de compter l'appel : un nom refusé ne lance rien
  const call = async (build: () => string[]) => {
    const argv = build();
    n++;
    await run(argv);
  };
  return {
    freeze: (s) => call(() => freezeArgv(s)),
    thaw: (s) => call(() => thawArgv(s)),
    thawSync: (s) => {
      const argv = thawArgv(s);
      n++;
      runSync(argv);
    },
    calls: () => n,
  };
}
