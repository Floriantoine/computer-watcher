import type { GroupSummary, KillResult, KillTarget, ProcInfo, SystemInfo } from '../../core/types';

export type SortKey = 'mem' | 'cpu' | 'age' | 'name';

export interface ViewFilter {
  query: string;
  sort: SortKey;
  minAgeSec: number;
}

const mem = (g: GroupSummary) => g.rssKB + g.swapKB;

const comparators: Record<SortKey, (a: GroupSummary, b: GroupSummary) => number> = {
  mem: (a, b) => mem(b) - mem(a),
  cpu: (a, b) => b.cpuPercent - a.cpuPercent,
  age: (a, b) => b.oldestAgeSec - a.oldestAgeSec,
  name: (a, b) => a.label.localeCompare(b.label, 'fr'),
};

/**
 * Groupes affichés, triés, « Autres » en dernier. La recherche plein texte est faite côté main (les arbres n'arrivent
 * pas ici) : `matches` = ids retenus pour la recherche en cours, null sans recherche.
 */
export function visibleGroups(groups: GroupSummary[], f: ViewFilter, matches: Set<string> | null = null): GroupSummary[] {
  const kept = groups.filter((g) => g.oldestAgeSec >= f.minAgeSec && (!matches || matches.has(g.id)));
  const regular = kept.filter((g) => g.kind !== 'others').sort(comparators[f.sort]);
  return [...regular, ...kept.filter((g) => g.kind === 'others')];
}

export function findGroup(groups: GroupSummary[], id: string): GroupSummary | undefined {
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

const targetOf = (p: ProcInfo): KillTarget => ({ pid: p.pid, startTicks: p.startTicks });

export interface KillRequest {
  targets: KillTarget[];
  title: string;
  needsConfirm: boolean;
  protectedProcs: ProcInfo[];
}

/** `all` : processus du groupe au dernier snapshot (`window.procWatch.groupProcs`). */
export function killRequestForGroup(g: GroupSummary, all: ProcInfo[], isProtected: (n: string) => boolean, currentUid: number): KillRequest {
  const procs = all.filter((p) => p.uid === currentUid);
  return {
    targets: procs.map(targetOf),
    title: `Tuer ${procs.length} processus « ${g.label} » ?`,
    needsConfirm: true,
    protectedProcs: procs.filter((p) => isProtected(p.name)),
  };
}

export function killRequestForProc(p: ProcInfo, isProtected: (n: string) => boolean, _currentUid: number): KillRequest {
  const prot = isProtected(p.name);
  return { targets: [targetOf(p)], title: `Tuer « ${p.name} » (PID ${p.pid}) ?`, needsConfirm: prot, protectedProcs: prot ? [p] : [] };
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

/** Messages d'erreur d'un lot de résultats ; les erreurs identiques sont regroupées en un seul toast. */
export function killResultMessages(results: KillResult[]): string[] {
  const byError = new Map<string, KillResult[]>();
  for (const r of results) {
    if (r.ok || r.error === 'ESRCH') continue;
    const key = r.error ?? 'inconnue';
    byError.set(key, [...(byError.get(key) ?? []), r]);
  }
  const out: string[] = [];
  for (const [error, rs] of byError) {
    if (rs.length === 1) out.push(killErrorMessage(rs[0]!)!);
    else if (error === 'SELF') out.push(`${rs.length} processus refusés : c'est proc-watch ou l'un de ses parents`);
    else if (error === 'EPERM') out.push(`${rs.length} processus : permission refusée`);
    else out.push(`${rs.length} processus : ${error}`);
  }
  return out;
}

export function ipcErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
}
