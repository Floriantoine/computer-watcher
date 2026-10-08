// Option « Mémoire : PSS » : la mémoire partagée (bibliothèques, pages communes d'Electron…) est répartie entre les
// processus qui la partagent. Lue dans /proc/<pid>/smaps_rollup (coûteux : le noyau parcourt toutes les zones mémoire),
// donc seulement pour les processus des groupes affichés, et au plus toutes les 10 s par processus.
import { readFileSync } from 'node:fs';
import { flattenGroup } from '../snapshot';
import type { Group, ProcInfo } from '../types';

const PSS_LINE = /^Pss:\s+(\d+)\s*kB/m;

/** Champ « Pss: » de smaps_rollup, en kB ; null s'il manque. */
export function parsePss(content: string): number | null {
  const m = PSS_LINE.exec(content);
  return m ? Number(m[1]) : null;
}

/** PSS en kB, ou 'denied' : illisible (autre utilisateur, hidepid, thread noyau) → l'affichage garde le RSS. */
export type PssValue = number | 'denied';

const defaultRead = (path: string) => readFileSync(path, 'utf8');

export interface PssCacheOptions {
  /**
   * Temps de lecture au plus par passe pour les entrées périmées (les plus anciennes d'abord ; les autres gardent leur
   * valeur jusqu'à la passe suivante). Les processus sans valeur sont toujours lus. Défaut : 25 ms.
   */
  refreshBudgetMs?: number;
  clock?: () => number;
}

export class PssCache {
  private readonly entries = new Map<string, { value: PssValue; at: number }>();
  private readonly refreshBudgetMs: number;
  private readonly clock: () => number;

  constructor(
    private readonly procRoot = '/proc',
    private readonly maxAgeMs = 10_000,
    private readonly read: (path: string) => string = defaultRead,
    opts: PssCacheOptions = {},
  ) {
    this.refreshBudgetMs = opts.refreshBudgetMs ?? 25;
    this.clock = opts.clock ?? (() => performance.now());
  }

  /**
   * PSS par pid ; relu au plus toutes les maxAgeMs par `${pid}:${startTicks}` ; EACCES/EPERM/Pss absent → 'denied' ;
   * ENOENT (processus mort entre deux lectures) → absent ; purge des clés non demandées.
   * Lire smaps_rollup coûte ~10 ms pour un gros processus (Chrome, Electron) : les relectures sont étalées sur plusieurs
   * passes (refreshBudgetMs), une valeur peut donc avoir un peu plus de maxAgeMs.
   */
  update(targets: readonly { pid: number; startTicks: number }[], now: number): Map<number, PssValue> {
    const out = new Map<number, PssValue>();
    const keep = new Set<string>();
    const stale: { key: string; pid: number; at: number }[] = [];
    for (const { pid, startTicks } of targets) {
      const key = `${pid}:${startTicks}`;
      if (keep.has(key)) continue;
      keep.add(key);
      const cached = this.entries.get(key);
      if (cached) {
        out.set(pid, cached.value);
        if (!(now - cached.at >= 0 && now - cached.at < this.maxAgeMs)) stale.push({ key, pid, at: cached.at });
        continue;
      }
      this.refresh(key, pid, now, out);
    }
    for (const key of this.entries.keys()) if (!keep.has(key)) this.entries.delete(key);
    if (stale.length) {
      stale.sort((a, b) => a.at - b.at);
      const start = this.clock();
      for (const s of stale) {
        if (this.clock() - start >= this.refreshBudgetMs) break;
        this.refresh(s.key, s.pid, now, out);
      }
    }
    return out;
  }

  private refresh(key: string, pid: number, now: number, out: Map<number, PssValue>): void {
    const value = this.readOne(pid);
    if (value === null) {
      this.entries.delete(key);
      out.delete(pid);
      return;
    }
    this.entries.set(key, { value, at: now });
    out.set(pid, value);
  }

  clear(): void {
    this.entries.clear();
  }

  /** null : le processus n'existe plus. */
  private readOne(pid: number): PssValue | null {
    try {
      return parsePss(this.read(`${this.procRoot}/${pid}/smaps_rollup`)) ?? 'denied';
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ESRCH') return null;
      return 'denied'; // EACCES, EPERM, ou autre erreur de lecture : repli RSS pour ce seul processus
    }
  }
}

/** number → rssKB = PSS ; 'denied' → pssDenied: true (rssKB inchangé) ; absent → inchangé (même objet). */
export function applyPss(procs: ProcInfo[], pss: ReadonlyMap<number, PssValue>): ProcInfo[] {
  if (pss.size === 0) return procs;
  return procs.map((p) => {
    const v = pss.get(p.pid);
    if (v === undefined) return p;
    return v === 'denied' ? { ...p, pssDenied: true } : { ...p, rssKB: v };
  });
}

/**
 * Processus des groupes affichés : tous les groupes de premier niveau sauf « Autres », plus ses sous-groupes si
 * includeOthers. `alsoOthers` : sous-groupes de « Autres » à inclure quand même (ceux qui dépassent le seuil en RSS
 * et n'y sont qu'en PSS ; sans leur PSS ils ressortiraient en carte au tick suivant, puis y retomberaient).
 */
export function pssTargets(groups: readonly Group[], includeOthers: boolean, alsoOthers?: (sub: Group) => boolean): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const g of groups) {
    if (g.kind !== 'others') out.push(...flattenGroup(g));
    else if (includeOthers) out.push(...flattenGroup(g));
    else if (alsoOthers) for (const s of g.subgroups) if (alsoOthers(s)) out.push(...flattenGroup(s));
  }
  return out;
}
