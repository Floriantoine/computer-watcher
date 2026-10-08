import type { Group, ProcInfo, ProcNode } from '../types';
import { matchCommand } from './rules';

/** Racine d'instance et tous les processus de l'instance (racine d'abord, ordre de parcours). */
export interface InstanceDraft { root: ProcNode; procs: ProcInfo[] }

export interface InstanceSplit {
  instances: InstanceDraft[];
  /** Lanceurs (npm, concurrently, sh -c…) : hors de toute instance, ni classés ni tués par un kill d'instance. */
  launchers: ProcInfo[];
}

/** Processus reconnu par une règle de commande, sur sa seule ligne de commande. */
export const isMatched = (p: ProcInfo): boolean => matchCommand([p]) !== null;

function subtree(n: ProcNode, out: ProcInfo[] = []): ProcInfo[] {
  const stack = [n];
  while (stack.length) {
    const cur = stack.pop()!;
    out.push(cur.proc);
    for (let i = cur.children.length - 1; i >= 0; i--) stack.push(cur.children[i]);
  }
  return out;
}

const older = (a: ProcNode, b: ProcNode) => a.proc.startTicks - b.proc.startTicks || a.proc.pid - b.proc.pid;

/**
 * Découpe un groupe en instances.
 * Groupes projet / dossier supprimé : les racines d'instance sont les nœuds reconnus (règle de commande) les plus
 * hauts ; une instance = sa racine et tous ses descendants. Un nœud non reconnu qui a au moins une instance parmi ses
 * descendants est un lanceur (npm, pnpm, concurrently, nodemon, sh -c…) : il n'appartient à aucune instance. Un nœud
 * non reconnu sans instance en dessous forme sa propre instance (avec son sous-arbre).
 * `hasInstanceBelow(pid)` peut signaler une instance descendante hors du groupe (wrapper `sh -c` rangé ailleurs) ;
 * il s'ajoute à ce que montre l'arbre du groupe.
 * Autres groupes : une seule instance, racine = la racine la plus ancienne (startTicks puis pid), pour une clé stable.
 */
export function splitInstances(group: Group, hasInstanceBelow?: (pid: number) => boolean): InstanceSplit {
  if (group.roots.length === 0 || group.kind === 'others') return { instances: [], launchers: [] };
  if (group.kind !== 'project' && group.kind !== 'deleted') {
    const roots = [...group.roots].sort(older);
    const procs: ProcInfo[] = [];
    for (const r of roots) subtree(r, procs);
    return { instances: [{ root: roots[0], procs }], launchers: [] };
  }

  // Mémo « une instance en dessous » dans l'arbre du groupe (nœud reconnu parmi les descendants stricts).
  const below = new Map<ProcNode, boolean>();
  const matched = new Map<ProcNode, boolean>();
  const isM = (n: ProcNode) => {
    let m = matched.get(n);
    if (m === undefined) { m = isMatched(n.proc); matched.set(n, m); }
    return m;
  };
  const computeBelow = (n: ProcNode): boolean => {
    let any = false;
    for (const c of n.children) if (computeBelow(c) || isM(c)) any = true;
    below.set(n, any);
    return any;
  };
  group.roots.forEach(computeBelow);

  const instances: InstanceDraft[] = [];
  const launchers: ProcInfo[] = [];
  const visit = (n: ProcNode) => {
    if (isM(n)) { instances.push({ root: n, procs: subtree(n) }); return; }
    if (below.get(n) || hasInstanceBelow?.(n.proc.pid)) {
      launchers.push(n.proc);
      n.children.forEach(visit);
      return;
    }
    instances.push({ root: n, procs: subtree(n) });
  };
  group.roots.forEach(visit);
  return { instances, launchers };
}

export function findInstances(group: Group, hasInstanceBelow?: (pid: number) => boolean): InstanceDraft[] {
  return splitInstances(group, hasInstanceBelow).instances;
}
