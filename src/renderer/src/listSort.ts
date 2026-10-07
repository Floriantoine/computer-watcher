import type { GroupSummary as Group } from '../../core/types';

export type ListColumn = 'name' | 'procs' | 'mem' | 'swap' | 'cpu' | 'age';

const key: Record<ListColumn, (g: Group) => number | string> = {
  name: (g) => g.label.toLocaleLowerCase('fr'),
  procs: (g) => g.procCount,
  mem: (g) => g.rssKB + g.swapKB,
  swap: (g) => g.swapKB,
  cpu: (g) => g.cpuPercent,
  age: (g) => g.oldestAgeSec,
};

export function sortForList(groups: Group[], col: ListColumn, dir: 'asc' | 'desc'): Group[] {
  const k = key[col];
  const sign = dir === 'asc' ? 1 : -1;
  const regular = groups.filter((g) => g.kind !== 'others').sort((a, b) => {
    const x = k(a);
    const y = k(b);
    return (typeof x === 'string' ? x.localeCompare(y as string, 'fr') : x - (y as number)) * sign;
  });
  return [...regular, ...groups.filter((g) => g.kind === 'others')];
}
