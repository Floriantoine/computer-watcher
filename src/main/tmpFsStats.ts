// Taille et occupation de /tmp (statfs) pour les tuiles de la page /tmp. Lecture seule : rien n'est parcouru ni modifié.
import { statfs as nodeStatfs } from 'node:fs/promises';
import { totalmem } from 'node:os';
import type { TmpFsStats } from '../core/types';

type Statfs = (path: string) => Promise<{ type: number; bsize: number; blocks: number; bfree: number }>;

/** Systèmes de fichiers en mémoire (statfs f_type) : tmpfs, ramfs. */
const IN_RAM = new Set([0x01021994, 0x858458f6]);

const REASONS: Record<string, string> = { EACCES: 'accès refusé', EPERM: 'accès refusé', ENOENT: 'introuvable', ENOTDIR: 'pas un dossier' };

/**
 * Taille du système de fichiers de `root` et place occupée (blocs totaux moins blocs libres, comme `df`), RAM totale, et
 * si ce système de fichiers est en RAM (tmpfs).
 * Échec de statfs : erreur au message court et lisible (« accès refusé (EACCES) »), jamais de valeurs inventées.
 */
export async function tmpFsStats(
  root: string,
  { statfs = nodeStatfs as Statfs, memTotalKB = () => Math.round(totalmem() / 1024) }: { statfs?: Statfs; memTotalKB?: () => number } = {},
): Promise<TmpFsStats> {
  let st;
  try {
    st = await statfs(root);
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') throw new Error(`${REASONS[code] ?? 'lecture impossible'} (${code})`);
    throw new Error('lecture impossible');
  }
  const kb = (blocks: number) => Math.round((blocks * st.bsize) / 1024);
  return { root, sizeKB: kb(st.blocks), usedKB: kb(st.blocks - st.bfree), memTotalKB: memTotalKB(), inRam: IN_RAM.has(st.type) };
}
