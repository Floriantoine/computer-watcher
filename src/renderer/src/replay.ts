// src/renderer/src/replay.ts — rejeu « voyage dans le temps » : arbre reconstruit depuis l'historique (pur)
import type { ProcNode, ProcTreeAt, ProcTreeRow, TimeRange } from '../../core/types';

export interface ReplayNode { row: ProcTreeRow; dead: boolean; diedAt: number | null; children: ReplayNode[] }

const memOf = (r: ProcTreeRow): number => r.rssKB + (r.swapKB ?? 0);

/** Arbre par ppid (parent absent → racine, cycle cassé), tri mémoire décroissante ; dead = !alive(pid, startTicks), diedAt = lastSeenTs si dead. */
export function replayTree(rows: readonly ProcTreeRow[], alive: (pid: number, startTicks: number) => boolean): ReplayNode[] {
  const nodes = rows.map((row): ReplayNode => {
    const dead = !alive(row.pid, row.startTicks);
    return { row, dead, diedAt: dead ? row.lastSeenTs : null, children: [] };
  });
  const byPid = new Map<number, ReplayNode>();
  for (const n of nodes) if (!byPid.has(n.row.pid)) byPid.set(n.row.pid, n);
  const parent = new Map<ReplayNode, ReplayNode>();
  for (const n of nodes) {
    const p = n.row.ppid === null ? undefined : byPid.get(n.row.ppid);
    if (!p || p === n) continue;
    // Le lien est refusé s'il fermerait un cycle (n serait son propre ancêtre).
    let a: ReplayNode | undefined = p;
    while (a && a !== n) a = parent.get(a);
    if (!a) parent.set(n, p);
  }
  const roots: ReplayNode[] = [];
  for (const n of nodes) {
    const p = parent.get(n);
    if (p) p.children.push(n);
    else roots.push(n);
  }
  const sort = (ns: ReplayNode[]): ReplayNode[] => {
    ns.sort((a, b) => memOf(b.row) - memOf(a.row));
    for (const n of ns) sort(n.children);
    return ns;
  };
  return sort(roots);
}

/** Clés `${pid}:${startTicks}` de l'arbre en direct du groupe. */
export function liveKeySet(roots: readonly ProcNode[] | null): Set<string> {
  const out = new Set<string>();
  const visit = (n: ProcNode): void => {
    out.add(`${n.proc.pid}:${n.proc.startTicks}`);
    n.children.forEach(visit);
  };
  roots?.forEach(visit);
  return out;
}

/** Vitesse de lecture du rejeu : 1 min d'historique par seconde. */
export const REPLAY_SPEED = 60;

/** Instant suivant après elapsedMs de lecture (×60), borné à range.to (done: true au bout). */
export function nextReplayTs(ts: number, range: TimeRange, elapsedMs: number): { ts: number; done: boolean } {
  const next = ts + elapsedMs * REPLAY_SPEED;
  return next >= range.to ? { ts: range.to, done: true } : { ts: next, done: false };
}

/**
 * Instant figé par un clic : l'échantillon sous le curseur tant que les points sont fins (≤ 1 min), sinon (7 j, 30 j :
 * buckets d'une heure) l'instant cliqué lui-même — l'arbre est alors celui de la minute enregistrée la plus proche.
 */
export function replayInstant(snapped: number, exact: number, stepMs: number): number {
  return stepMs > 60_000 ? Math.round(exact) : snapped;
}

/**
 * Clic simple différé : un double-clic (retour du zoom) envoie deux `click` puis `dblclick` ; seul un clic resté seul
 * pendant `delayMs` fige l'instant. `cancel` au dblclick.
 */
export class ClickDelay {
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private delayMs: number, private fire: (ts: number) => void) {}
  click(ts: number): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fire(ts);
    }, this.delayMs);
  }
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  dispose(): void {
    this.cancel();
  }
}

/** Arbre vide : trou d'enregistrement (service arrêté) ou groupe sous les seuils d'enregistrement. */
export function replayEmptyText(t: ProcTreeAt): string {
  return t.recorded
    ? "Aucun processus au-dessus des seuils d'enregistrement à cet instant"
    : "Trou d'enregistrement : le service n'échantillonnait pas à cet instant";
}
