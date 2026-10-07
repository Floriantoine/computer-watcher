import type { Group, KillResult, ProcInfo, ProcNode, SystemInfo } from '../../core/types';

export type SortKey = 'mem' | 'cpu' | 'age' | 'name';

export interface ViewFilter {
  query: string;
  sort: SortKey;
  minAgeSec: number;
}

const mem = (g: Group) => g.rssKB + g.swapKB;

function flattenNodes(nodes: ProcNode[], out: ProcInfo[] = []): ProcInfo[] {
  for (const n of nodes) {
    out.push(n.proc);
    flattenNodes(n.children, out);
  }
  return out;
}

export function flattenProcs(g: Group): ProcInfo[] {
  return [...flattenNodes(g.roots), ...g.subgroups.flatMap(flattenProcs)];
}

function matches(g: Group, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  if (g.label.toLowerCase().includes(q)) return true;
  return flattenProcs(g).some((p) => p.cmdline.toLowerCase().includes(q) || (p.cwd ?? '').toLowerCase().includes(q));
}

const comparators: Record<SortKey, (a: Group, b: Group) => number> = {
  mem: (a, b) => mem(b) - mem(a),
  cpu: (a, b) => b.cpuPercent - a.cpuPercent,
  age: (a, b) => b.oldestAgeSec - a.oldestAgeSec,
  name: (a, b) => a.label.localeCompare(b.label, 'fr'),
};

export function visibleGroups(groups: Group[], f: ViewFilter): Group[] {
  const kept = groups.filter((g) => g.oldestAgeSec >= f.minAgeSec && matches(g, f.query.trim()));
  const regular = kept.filter((g) => g.kind !== 'others').sort(comparators[f.sort]);
  return [...regular, ...kept.filter((g) => g.kind === 'others')];
}

export function findGroup(groups: Group[], id: string): Group | undefined {
  for (const g of groups) {
    if (g.id === id) return g;
    const inner = findGroup(g.subgroups, id);
    if (inner) return inner;
  }
  return undefined;
}

export type Level = 'ok' | 'warn' | 'bad';

export function swapPercent(s: SystemInfo): number {
  return s.swapTotalKB ? (1 - s.swapFreeKB / s.swapTotalKB) * 100 : 0;
}

export function pressureLevel(s: SystemInfo): Level {
  const swap = swapPercent(s);
  const psi = s.psiSome10 ?? 0;
  if (swap >= 70 || psi >= 25) return 'bad';
  if (swap >= 50 || psi >= 10) return 'warn';
  return 'ok';
}

export interface KillRequest {
  pids: number[];
  title: string;
  needsConfirm: boolean;
  protectedProcs: ProcInfo[];
}

export function killRequestForGroup(g: Group, isProtected: (n: string) => boolean, currentUid: number): KillRequest {
  const procs = flattenProcs(g).filter((p) => p.uid === currentUid);
  return {
    pids: procs.map((p) => p.pid),
    title: `Tuer ${procs.length} processus « ${g.label} » ?`,
    needsConfirm: true,
    protectedProcs: procs.filter((p) => isProtected(p.name)),
  };
}

export function killRequestForProc(p: ProcInfo, isProtected: (n: string) => boolean, _currentUid: number): KillRequest {
  const prot = isProtected(p.name);
  return { pids: [p.pid], title: `Tuer « ${p.name} » (PID ${p.pid}) ?`, needsConfirm: prot, protectedProcs: prot ? [p] : [] };
}

export const FORCE_AFTER_MS = 3000;

export function trackKills(pending: Map<number, number>, presentPids: Set<number>, now: number) {
  const next = new Map<number, number>();
  const stuck = new Set<number>();
  for (const [pid, sentAt] of pending) {
    if (!presentPids.has(pid)) continue;
    next.set(pid, sentAt);
    if (now - sentAt >= FORCE_AFTER_MS) stuck.add(pid);
  }
  return { pending: next, stuck };
}

export function killErrorMessage(r: KillResult): string | null {
  if (r.ok || r.error === 'ESRCH') return null;
  if (r.error === 'EPERM') return `PID ${r.pid} : permission refusée`;
  if (r.error === 'SELF') return `PID ${r.pid} : refusé, c'est proc-watch ou l'un de ses parents`;
  return `PID ${r.pid} : ${r.error}`;
}
