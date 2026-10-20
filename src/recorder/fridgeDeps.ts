// Vraies dépendances du frigo (anti-gel lot 3) pour le service : busctl (systemBin, asynchrone et synchrone), lectures et
// memory.reclaim sous /sys/fs/cgroup. Coupées par PROC_WATCH_NO_ANTIGEL=1 comme le reste de l'anti-gel.
// Lectures : seulement sous …/user@<uid>.service/cwatch.slice/, fichiers d'une liste fermée, sans suivre de lien.
// Écriture : seulement memory.reclaim d'une slice de projet (cwatch-p-<clé>.slice, ou slice de projet de test) sur son
// chemin exact dans la hiérarchie de systemd.
import { closeSync, constants, existsSync, openSync, readdirSync, readSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { probeAvailability, userBaseOf } from '../core/antigel/cgroupfs';
import type { FridgeDeps } from '../core/antigel/fridge';
import { createBusctlSync, createFridgeClient } from '../core/antigel/fridgeSystemd';
import { BusctlError, createBusctl } from '../core/antigel/systemd';
import { ROOT_SLICE, isProjectSliceName, slicePath } from '../core/antigel/units';
import { systemBin } from '../core/childEnv';

const READABLE = new Set(['cgroup.freeze', 'cgroup.events', 'cgroup.procs', 'memory.current', 'memory.stat', 'memory.swap.max', 'memory.swap.current']);
const MAX_READ = 256 * 1024;

/** Chemin de cgroup sous cwatch.slice de cet utilisateur (« /user.slice/…/cwatch.slice[/…] »), sinon null. */
export function underCwatch(cg: string, uid: number): string | null {
  if (typeof cg !== 'string' || !cg.startsWith('/') || cg.includes('\0') || cg.split('/').some((s) => s === '..' || s === '.')) return null;
  const base = userBaseOf(cg, uid);
  if (!base) return null;
  const root = `${base}/${ROOT_SLICE}`;
  return cg === root || cg.startsWith(`${root}/`) ? cg : null;
}

/** Slice de projet sur son chemin exact (algorithme des « - » de systemd), sinon null : seule cible de memory.reclaim. */
export function reclaimPath(cg: string, uid: number): string | null {
  if (!underCwatch(cg, uid)) return null;
  const base = userBaseOf(cg, uid)!;
  const name = cg.split('/').pop()!;
  if (!isProjectSliceName(name)) return null;
  return cg === `${base}/${slicePath(name)}` ? cg : null;
}

function readBounded(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(MAX_READ);
    let n = 0;
    while (n < buf.length) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
    }
    return buf.toString('utf8', 0, n);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export function fridgeDepsFor(o: {
  env: NodeJS.ProcessEnv; uid: number; selfPid: number; exists?: (p: string) => boolean; procRoot?: string; sysfsRoot?: string;
}): Omit<FridgeDeps, 'log' | 'monoNow'> | undefined {
  if (o.env.PROC_WATCH_NO_ANTIGEL === '1') return undefined;
  const procRoot = o.procRoot ?? '/proc';
  const sysfsRoot = o.sysfsRoot ?? '/sys/fs/cgroup';
  const busctl = systemBin('busctl', o.exists ?? existsSync);
  const none = () => new BusctlError('busctl introuvable', 'unreachable');
  const client = createFridgeClient(
    busctl ? createBusctl(busctl, o.env) : async () => { throw none(); },
    busctl ? createBusctlSync(busctl, o.env) : () => { throw none(); },
  );
  return {
    client,
    probe: () => probeAvailability({ procRoot, sysfsRoot, uid: o.uid, selfPid: o.selfPid, busctl }),
    read: (cg, file) => {
      const c = underCwatch(cg, o.uid);
      return c && READABLE.has(file) ? readBounded(join(sysfsRoot, c, file)) : null;
    },
    list: (cg) => {
      const c = underCwatch(cg, o.uid);
      if (!c) return null;
      try {
        return readdirSync(join(sysfsRoot, c), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
      } catch {
        return null;
      }
    },
    // écriture asynchrone (pool de libuv) : la boucle du service n'attend jamais le noyau
    reclaim: async (cg, bytes) => {
      const c = reclaimPath(cg, o.uid);
      if (!c) throw new Error(`memory.reclaim refusé : ${cg}`);
      if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`taille refusée : ${bytes}`);
      const fh = await open(join(sysfsRoot, c, 'memory.reclaim'), constants.O_WRONLY | constants.O_NOFOLLOW);
      try {
        await fh.write(String(bytes));
        return 'ok';
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EAGAIN') return 'again';
        throw e;
      } finally {
        await fh.close();
      }
    },
  };
}
