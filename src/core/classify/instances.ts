import type { Group, ProcInfo, ProcNode } from '../types';
import { baseName, programIndex, splitArgs } from './argv';
import { matchCommand } from './rules';

/** Racine d'instance et tous les processus de l'instance (racine d'abord, ordre de parcours). */
export interface InstanceDraft { root: ProcNode; procs: ProcInfo[] }

const LAUNCHERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'sh', 'bash', 'concurrently', 'nodemon']);

/** Lanceur générique : par le nom (« npm run dev ») ou par le programme significatif (`node …/concurrently`). */
function isLauncher(p: ProcInfo): boolean {
  if (LAUNCHERS.has(p.name.split(/\s+/)[0] ?? '')) return true;
  const raw = splitArgs(p.cmdline);
  const i = programIndex(raw.map(baseName));
  const prog = i >= 0 ? baseName(raw[i]).replace(/\.(m?js|cjs)$/, '') : '';
  return LAUNCHERS.has(prog);
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

/** Enfant « serveur » : un processus de son sous-arbre correspond à une règle de commande. */
const isServer = (n: ProcNode): boolean => matchCommand(subtree(n)) !== null;

/** Sous-arbre d'une racine d'instance, en découpant les lanceurs génériques qui lancent plusieurs serveurs. */
function collect(root: ProcNode): InstanceDraft[] {
  const own: ProcInfo[] = [];
  const split: InstanceDraft[] = [];
  const visit = (n: ProcNode) => {
    own.push(n.proc);
    let servers: ProcNode[] = [];
    if (n.children.length > 1 && isLauncher(n.proc)) {
      servers = n.children.filter(isServer);
      if (servers.length < 2) servers = [];
    }
    for (const c of n.children) {
      if (servers.includes(c)) split.push(...collect(c));
      else visit(c);
    }
  };
  visit(root);
  // Après découpage, le reste (lanceurs seuls : npm, concurrently…) n'est pas une instance à part.
  if (split.length > 0 && own.every(isLauncher)) return split;
  return [{ root, procs: own }, ...split];
}

export function findInstances(group: Group): InstanceDraft[] {
  if (group.roots.length === 0 || group.kind === 'others') return [];
  if (group.kind === 'project' || group.kind === 'deleted') {
    // buildGroups ne met dans un groupe projet que des outils de dev (DEV_TOOL) : chaque racine du groupe
    // ouvre une instance (même sans règle, pour que tous ses processus aient une instance) et ses
    // descendants y appartiennent, sauf sous un lanceur générique qui lance plusieurs serveurs.
    return group.roots.flatMap((r) => collect(r));
  }
  const procs: ProcInfo[] = [];
  for (const r of group.roots) subtree(r, procs);
  return [{ root: group.roots[0], procs }];
}

