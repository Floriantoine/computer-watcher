import { APP_DISPLAY_NAME } from '../../core/appName';
import type { GroupSummary, InstanceSummary, KillResult, KillTarget, ProcInfo, SystemInfo } from '../../core/types';
import { cpuOutOfOrder, memOutOfOrder, stableOrder } from './stableOrder';

export type SortKey = 'mem' | 'swap' | 'cpu' | 'age' | 'name';

/** Tuiles du haut de la page Processus. */
export type SystemTile = 'mem' | 'swap' | 'psi' | 'load';
const TILE_SORT: Record<SystemTile, SortKey> = { mem: 'mem', swap: 'swap', psi: 'mem', load: 'cpu' };

/** Tri choisi en cliquant une tuile ; recliquer la tuile du tri actif revient au tri mémoire (par défaut). */
export function sortForTile(tile: SystemTile, current: SortKey): SortKey {
  const s = TILE_SORT[tile];
  return s === current && s !== 'mem' ? 'mem' : s;
}

/** Tuile mise en avant pour un tri (la pression suit la mémoire, sans être surlignée en double). */
export const tileForSort = (sort: SortKey): SystemTile | null => (sort === 'mem' ? 'mem' : sort === 'swap' ? 'swap' : sort === 'cpu' ? 'load' : null);

export interface ViewFilter {
  query: string;
  sort: SortKey;
  minAgeSec: number;
}

const mem = (g: GroupSummary) => g.rssKB + g.swapKB;

const comparators: Record<SortKey, (a: GroupSummary, b: GroupSummary) => number> = {
  mem: (a, b) => mem(b) - mem(a),
  swap: (a, b) => b.swapKB - a.swapKB || mem(b) - mem(a),
  cpu: (a, b) => b.cpuPercent - a.cpuPercent,
  age: (a, b) => b.oldestAgeSec - a.oldestAgeSec,
  name: (a, b) => a.label.localeCompare(b.label, 'fr'),
};

const tolerant: Partial<Record<SortKey, (a: GroupSummary, b: GroupSummary) => boolean>> = { mem: memOutOfOrder, cpu: cpuOutOfOrder };

/**
 * Groupes affichés, triés, « Autres » en dernier. La recherche plein texte est faite côté main (les arbres n'arrivent
 * pas ici) : `matches` = ids retenus pour la recherche en cours, null sans recherche.
 * `prevOrder` (ids affichés au snapshot précédent, même tri) : tri mémoire/CPU avec tolérance, voir stableOrder.
 */
export function visibleGroups(groups: GroupSummary[], f: ViewFilter, matches: Set<string> | null = null, prevOrder: readonly string[] = []): GroupSummary[] {
  const kept = groups.filter((g) => g.oldestAgeSec >= f.minAgeSec && (!matches || matches.has(g.id)));
  const sorted = kept.filter((g) => g.kind !== 'others').sort(comparators[f.sort]);
  const tol = tolerant[f.sort];
  const regular = tol && prevOrder.length ? stableOrder(sorted, prevOrder, (g) => g.id, tol) : sorted;
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

export { pressureLevel, swapPercent, type Level } from '../../core/pressure';

const targetOf = (p: ProcInfo): KillTarget => ({ pid: p.pid, startTicks: p.startTicks });

export interface KillRequest {
  targets: KillTarget[];
  title: string;
  needsConfirm: boolean;
  protectedProcs: ProcInfo[];
}

/** Les plus profonds d'abord (ordre stable à profondeur égale) : un kill découpé en lots garde « enfants avant parents ». */
export function childrenFirst(procs: readonly ProcInfo[]): ProcInfo[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const depth = new Map<number, number>();
  const depthOf = (p: ProcInfo): number => {
    let d = 0;
    const seen = new Set<number>();
    for (let cur = byPid.get(p.ppid); cur && !seen.has(cur.pid); cur = byPid.get(cur.ppid)) {
      seen.add(cur.pid);
      d++;
    }
    return d;
  };
  for (const p of procs) depth.set(p.pid, depthOf(p));
  return [...procs].sort((a, b) => depth.get(b.pid)! - depth.get(a.pid)!);
}

/** `all` : processus du groupe au dernier snapshot (`window.procWatch.groupProcs`). */
export function killRequestForGroup(g: Pick<GroupSummary, 'label'>, all: ProcInfo[], isProtected: (n: string) => boolean, currentUid: number): KillRequest {
  const procs = childrenFirst(all.filter((p) => p.uid === currentUid));
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

/**
 * Kill d'une instance : `targets` vient du main (`instances:targets`), `all` = processus du groupe au dernier snapshot.
 * Ne garde que les processus de l'utilisateur encore identiques (même startTicks) ; confirmation si l'instance ou l'un
 * de ses processus est protégé.
 */
export function killRequestForInstance(inst: InstanceSummary, targets: KillTarget[], all: ProcInfo[], isProtected: (n: string) => boolean, currentUid: number): KillRequest {
  const byPid = new Map(all.map((p) => [p.pid, p]));
  const procs = targets.flatMap((t) => {
    const p = byPid.get(t.pid);
    return p && p.uid === currentUid && p.startTicks === t.startTicks ? [p] : [];
  });
  const protectedProcs = procs.filter((p) => isProtected(p.name));
  return {
    targets: procs.map(targetOf),
    title: `Tuer l'instance « ${inst.label} » (${procs.length} processus) ?`,
    needsConfirm: inst.protected || protectedProcs.length > 0,
    protectedProcs,
  };
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
  if (r.error === 'SELF') return `PID ${r.pid} : refusé, c'est ${APP_DISPLAY_NAME} ou l'un de ses parents`;
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
    else if (error === 'SELF') out.push(`${rs.length} processus refusés : c'est ${APP_DISPLAY_NAME} ou l'un de ses parents`);
    else if (error === 'EPERM') out.push(`${rs.length} processus : permission refusée`);
    else out.push(`${rs.length} processus : ${error}`);
  }
  return out;
}

export function ipcErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
}
