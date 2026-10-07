import type { ProcNode } from '../../core/types';

export interface BranchTotal { memKB: number; count: number }

export const nodeKey = (n: ProcNode): string => `${n.proc.pid}:${n.proc.startTicks}`;

/** Total RAM+swap et nombre de processus (elle + descendants) de chaque branche, par clé `pid:startTicks`. */
export function branchTotals(roots: ProcNode[]): Map<string, BranchTotal> {
  const out = new Map<string, BranchTotal>();
  const visit = (n: ProcNode): BranchTotal => {
    const t: BranchTotal = { memKB: n.proc.rssKB + n.proc.swapKB, count: 1 };
    for (const c of n.children) {
      const ct = visit(c);
      t.memKB += ct.memKB;
      t.count += ct.count;
    }
    out.set(nodeKey(n), t);
    return t;
  };
  for (const r of roots) visit(r);
  return out;
}

/** Clés des nœuds qui ont des enfants (les seuls qu'on peut déplier). */
export function allExpandableKeys(roots: ProcNode[]): string[] {
  const out: string[] = [];
  const visit = (n: ProcNode) => {
    if (n.children.length) out.push(nodeKey(n));
    n.children.forEach(visit);
  };
  roots.forEach(visit);
  return out;
}
