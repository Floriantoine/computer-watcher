// Option « Mémoire : RSS | PSS » : libellés et infobulles de la page Processus et du détail.
import type { MemoryMetric, ProcInfo } from '../../core/types';

export const memLabel = (m: MemoryMetric): 'RAM' | 'PSS' => (m === 'pss' ? 'PSS' : 'RAM');

/** Infobulle d'un processus : « RSS (PSS illisible) » en mode PSS si pssDenied, sinon undefined. */
export function procMemTitle(p: Pick<ProcInfo, 'pssDenied'>, m: MemoryMetric): string | undefined {
  return m === 'pss' && p.pssDenied ? 'RSS (PSS illisible)' : undefined;
}

/** Mode PSS : la comparaison du badge « fuite ? » avec la mémoire enregistrée (RSS) n'a pas de sens → pas de memOf. */
export function leakMemOf(m: MemoryMetric, mem: Map<string, number>): ((key: string) => number | undefined) | undefined {
  return m === 'pss' ? undefined : (key) => mem.get(key);
}
