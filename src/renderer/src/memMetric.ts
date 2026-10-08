// Option « Mémoire : RSS | PSS » : libellés et infobulles de la page Processus et du détail.
import type { GroupSummary, MemoryMetric, ProcInfo } from '../../core/types';

export const memLabel = (m: MemoryMetric): 'RAM' | 'PSS' => (m === 'pss' ? 'PSS' : 'RAM');

/** Infobulle d'un processus en mode PSS : « RSS (PSS illisible) » si pssDenied, « PSS pas encore lu » si pssPending. */
export function procMemTitle(p: Pick<ProcInfo, 'pssDenied' | 'pssPending'>, m: MemoryMetric): string | undefined {
  if (m !== 'pss') return undefined;
  if (p.pssDenied) return 'RSS (PSS illisible)';
  return p.pssPending ? 'PSS pas encore lu' : undefined;
}

/** Mode PSS : la comparaison du badge « fuite ? » avec la mémoire enregistrée (RSS) n'a pas de sens → pas de memOf. */
export function leakMemOf(m: MemoryMetric, mem: Map<string, number>): ((key: string) => number | undefined) | undefined {
  return m === 'pss' ? undefined : (key) => mem.get(key);
}

/** Libellé de la mémoire d'un groupe : « PSS* » si certains de ses processus sont restés en RSS. */
export function memTileLabel(m: MemoryMetric, g: Pick<GroupSummary, 'pssFallback'>): 'RAM' | 'PSS' | 'PSS*' {
  if (m !== 'pss') return 'RAM';
  return g.pssFallback ? 'PSS*' : 'PSS';
}

/** Infobulle du « PSS* » : « n processus en RSS (PSS illisible ou pas encore lu) » ; undefined sinon. */
export function fallbackTitle(m: MemoryMetric, g: Pick<GroupSummary, 'pssFallback'>): string | undefined {
  return m === 'pss' && g.pssFallback ? `${g.pssFallback} processus en RSS (PSS illisible ou pas encore lu)` : undefined;
}
