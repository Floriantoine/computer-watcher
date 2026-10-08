import type { Group, ProcInfo, ProcNode } from '../types';
import { baseName, programIndex, splitArgs } from './argv';
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

const LAUNCHERS = new Set(['npm', 'pnpm', 'yarn', 'npx', 'bunx', 'sh', 'bash', 'dash', 'zsh', 'env', 'concurrently', 'nodemon', 'npm-run-all', 'run-p', 'run-s', 'turbo']);

/**
 * Lanceur générique, d'après le programme significatif (`node …/concurrently.js` → concurrently) :
 * npm, pnpm, yarn, npx, sh/bash/dash/zsh, env, concurrently, nodemon, npm-run-all, run-p, run-s, turbo,
 * `bun run`/bunx, nx (hors `nx daemon`).
 */
export function isLauncher(p: ProcInfo): boolean {
  const raw = splitArgs(p.cmdline);
  const i = programIndex(raw.map(baseName));
  const prog = i >= 0 ? baseName(raw[i]).replace(/\.(m?js|cjs)$/, '') : (p.name.split(/\s+/)[0] ?? '');
  const rest = i >= 0 ? raw.slice(i + 1) : p.name.split(/\s+/).slice(1);
  if (LAUNCHERS.has(prog)) return true;
  if (prog === 'bun') return rest[0] === 'run';
  if (prog === 'nx') return !rest.includes('daemon');
  return false;
}

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
 * hauts ; une instance = sa racine et tous ses descendants. Un nœud non reconnu dont le programme est un lanceur
 * générique (`isLauncher`) et qui a au moins une instance parmi ses descendants est un lanceur : il n'appartient à
 * aucune instance. Tout autre nœud non reconnu forme sa propre instance avec tout son sous-arbre (un vrai serveur non
 * reconnu, ex. `node tools/serve.mjs` → `esbuild --watch`, absorbe ses descendants).
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
    if ((below.get(n) || hasInstanceBelow?.(n.proc.pid)) && isLauncher(n.proc)) {
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
