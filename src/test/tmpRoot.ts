// Racines temporaires des lancements de Vitest, sur disque sous ~/.cache/pw-vitest (jamais dans /tmp, qui est en RAM).
// Chaque racine porte son propriétaire dans son NOM, créé d'un coup par mkdtemp : `<pid>-<starttime>-<pidns>-XXXXXX`
// (pid du processus principal de Vitest, champ 22 de /proc/<pid>/stat, espace de noms de pid). Aucune fenêtre où une
// racine existe sans propriétaire connu ; un lancement tué (earlyoom, timeout, Ctrl-C, scope plafonné) laisse une racine
// dont le propriétaire est mort : le lancement suivant la purge.
import { readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Processus principal de Vitest qui possède une racine. `start` : starttime (tops d'horloge depuis le démarrage). */
export interface RootOwner {
  pid: number;
  start: string;
  /** Inode de l'espace de noms de pid (« pid:[4026531836] ») ; « 0 » s'il est illisible. */
  ns: string;
}

/** starttime (champ 22 de /proc/<pid>/stat), lu après la dernière parenthèse (le nom peut en contenir) ; null si illisible. */
export function readStartTime(pid: number | 'self', procRoot = '/proc'): string | null {
  let stat: string;
  try {
    stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
  } catch {
    return null;
  }
  const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return /^\d+$/.test(f[19] ?? '') ? f[19] : null;
}

function pidNamespace(procRoot = '/proc'): string {
  try {
    return /^pid:\[(\d+)\]$/.exec(readlinkSync(join(procRoot, 'self', 'ns', 'pid')))?.[1] ?? '0';
  } catch {
    return '0';
  }
}

/** Le processus courant (appelé dans le processus principal de Vitest, par le globalSetup). */
export function selfOwner(): RootOwner {
  return { pid: process.pid, start: readStartTime('self') ?? '0', ns: pidNamespace() };
}

/** Préfixe passé à mkdtemp (qui ajoute 6 caractères [A-Za-z0-9]). */
export const rootPrefix = (o: RootOwner): string => `${o.pid}-${o.start}-${o.ns}-`;

const NAME = /^([1-9]\d{0,9})-(\d{1,20})-(\d{1,20})-[A-Za-z0-9]{6}$/;

/** Propriétaire d'après le nom d'une racine ; null pour tout autre nom (jamais purgé). */
export function parseRootName(name: string): RootOwner | null {
  const m = NAME.exec(name);
  return m ? { pid: Number(m[1]), start: m[2], ns: m[3] } : null;
}

/**
 * Vrai seulement sur preuve que le propriétaire est mort : même espace de noms de pid que nous, et /proc/<pid> absent,
 * ou présent avec un autre starttime (pid réutilisé). Autre espace de noms (conteneur, flatpak), stat illisible ou mal
 * formé : faux (la racine est gardée).
 */
export function ownerDead(o: RootOwner, ctx: { ns: string; procRoot?: string }): boolean {
  if (o.ns !== ctx.ns || o.ns === '0') return false;
  const procRoot = ctx.procRoot ?? '/proc';
  let stat: string;
  try {
    stat = readFileSync(join(procRoot, String(o.pid), 'stat'), 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
  const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  if (!/^\d+$/.test(f[19] ?? '')) return false;
  return f[19] !== o.start;
}
