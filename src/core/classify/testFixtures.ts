import type { Group, GroupKind, ProcInfo, ProcNode } from '../types';

/** Fabriques de faux arbres de processus pour les tests du classement. */
let nextPid = 100;
export function proc(name: string, cmdline: string, over: Partial<ProcInfo> = {}): ProcInfo {
  const pid = over.pid ?? nextPid++;
  return {
    pid, ppid: 1, name, cmdline, uid: 1000, startTicks: pid * 10, ageSec: 100, cpuTicks: 0,
    rssKB: 1000, swapKB: 0, cwd: '/home/u/acme', cwdDeleted: false, cpuPercent: 1, ...over,
  };
}
export const node = (p: ProcInfo, ...children: ProcNode[]): ProcNode => {
  for (const c of children) c.proc.ppid = p.pid;
  return { proc: p, children };
};
export function group(id: string, kind: GroupKind, roots: ProcNode[]): Group {
  const all: ProcInfo[] = [];
  const walk = (n: ProcNode) => { all.push(n.proc); n.children.forEach(walk); };
  roots.forEach(walk);
  return {
    id, kind, label: id, tags: [], rootName: roots[0]?.proc.name ?? '', roots, pids: all.map((p) => p.pid),
    procCount: all.length, cpuPercent: 0, rssKB: 0, swapKB: 0, oldestAgeSec: 0, protected: false, killable: true, subgroups: [],
  };
}
