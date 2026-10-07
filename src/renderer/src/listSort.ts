import type { GroupSummary as Group } from '../../core/types';
import { cpuOutOfOrder, memOutOfOrder, stableOrder } from './stableOrder';

export type ListColumn = 'name' | 'procs' | 'mem' | 'swap' | 'cpu' | 'age';

const key: Record<ListColumn, (g: Group) => number | string> = {
  name: (g) => g.label.toLocaleLowerCase('fr'),
  procs: (g) => g.procCount,
  mem: (g) => g.rssKB + g.swapKB,
  swap: (g) => g.swapKB,
  cpu: (g) => g.cpuPercent,
  age: (g) => g.oldestAgeSec,
};

const tolerant: Partial<Record<ListColumn, (a: Group, b: Group) => boolean>> = { mem: memOutOfOrder, cpu: cpuOutOfOrder };

/** `prevOrder` : ids affichés au rendu précédent (même colonne, même sens) ; RAM et CPU triés avec tolérance (stableOrder). */
export function sortForList(groups: Group[], col: ListColumn, dir: 'asc' | 'desc', prevOrder: readonly string[] = []): Group[] {
  const k = key[col];
  const sign = dir === 'asc' ? 1 : -1;
  const sorted = groups.filter((g) => g.kind !== 'others').sort((a, b) => {
    const x = k(a);
    const y = k(b);
    return (typeof x === 'string' ? x.localeCompare(y as string, 'fr') : x - (y as number)) * sign;
  });
  const tol = tolerant[col];
  const regular = tol && prevOrder.length ? stableOrder(sorted, prevOrder, (g) => g.id, dir === 'desc' ? tol : (a, b) => tol(b, a)) : sorted;
  return [...regular, ...groups.filter((g) => g.kind === 'others')];
}
