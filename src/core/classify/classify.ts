import type { Group, InstanceSummary, ProcInfo, ProcNode } from '../types';
import { CATEGORIES, DUPLICATE_CATEGORIES, type Category } from './categories';
import { isMatched, splitInstances } from './instances';
import type { CommandMatch } from './match';
import { categoryForPorts } from './portRules';
import type { PackageHints } from './packageJson';
import { classifyByName, matchCommand } from './rules';
import { signatureOf } from './signature';

export interface DecideInput {
  overrideKey: string; overrides: Record<string, Category>;
  match: CommandMatch | null; ports: number[]; chainText: string; pkg: PackageHints | null;
  /** Optionnel : applique les règles de commande au texte d'un script package.json. */
  matchScript?: (script: string) => CommandMatch | null;
}

const SCRIPT_NAME = /^(dev|start)/;

export function decide(input: DecideInput): { category: Category; source: InstanceSummary['source'] } {
  const o = Object.prototype.hasOwnProperty.call(input.overrides, input.overrideKey) ? input.overrides[input.overrideKey] : undefined;
  if (o) return { category: o, source: 'manual' };
  if (input.match) return { category: input.match.category, source: 'command' };
  const port = categoryForPorts(input.ports, input.chainText);
  if (port) return { category: port, source: 'port' };
  const pkg = input.pkg;
  if (pkg) {
    if (input.matchScript && input.chainText.length >= 3) {
      for (const [name, script] of Object.entries(pkg.scripts)) {
        if (!SCRIPT_NAME.test(name) || !script.includes(input.chainText)) continue;
        const m = input.matchScript(script);
        if (m) return { category: m.category, source: 'package' };
      }
    }
    if (pkg.front) return { category: 'front', source: 'package' };
    if (pkg.back) return { category: 'back', source: 'package' };
  }
  return { category: 'unknown', source: 'unknown' };
}

export interface ClassifyContext {
  overrides: Record<string, Category>;
  /** Ports en écoute par pid (vide si non lus) */
  ports: Map<number, number[]>;
  pkg: (projectRoot: string) => PackageHints | null;
  isProtected: (name: string) => boolean;
}

export interface GroupClassification {
  categories: Category[];
  instances: InstanceSummary[];
  /** Lanceurs du groupe (npm, concurrently, sh -c…) : dans aucune instance ; à ajouter au kill « Tout arrêter le projet ». */
  launcherPids: number[];
}

const matchScript = (script: string): CommandMatch | null => {
  // Un script peut enchaîner plusieurs commandes (« a && b ») : la première qui correspond à une règle.
  const parts = script.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
  return matchCommand(parts.map((cmdline) => ({ name: '', cmdline })));
};

const PROJECT_PREFIX = 'project:';
const DUPLICATE_SOURCES: ReadonlySet<InstanceSummary['source']> = new Set(['manual', 'command', 'port']);

function classifyGroup(group: Group, ctx: ClassifyContext, hasInstanceBelow: (pid: number) => boolean): GroupClassification {
  const isProject = group.kind === 'project' || group.kind === 'deleted';
  const projectRoot = group.kind === 'project' && group.id.startsWith(PROJECT_PREFIX) ? group.id.slice(PROJECT_PREFIX.length) : null;
  const split = splitInstances(group, hasInstanceBelow);
  const instances: InstanceSummary[] = split.instances.map(({ root, procs }) => {
    const rp = root.proc;
    const match = isProject ? matchCommand(procs) : classifyByName(rp.name, rp.cmdline);
    const signature = signatureOf(procs, match, projectRoot);
    const portSet = new Set<number>();
    if (ctx.ports.size > 0) for (const p of procs) for (const port of ctx.ports.get(p.pid) ?? []) portSet.add(port);
    const ports = [...portSet].sort((a, b) => a - b);
    const overrideKey = `${projectRoot ?? group.id}|${signature}`;
    const pkg = projectRoot !== null && match === null ? ctx.pkg(projectRoot) : null;
    const d = decide({ overrideKey, overrides: ctx.overrides, match, ports, chainText: signature, pkg, matchScript });
    let rssKB = 0; let swapKB = 0; let cpuPercent = 0; let prot = false;
    for (const p of procs) {
      rssKB += p.rssKB; swapKB += p.swapKB; cpuPercent += p.cpuPercent;
      if (!prot && ctx.isProtected(p.name)) prot = true;
    }
    return {
      key: `${group.id}#${rp.pid}:${rp.startTicks}`, groupId: group.id, project: projectRoot,
      category: d.category, source: d.source === 'command' && !isProject ? 'name' : d.source,
      signature, label: match?.label ?? signature, rootPid: rp.pid, rootStartTicks: rp.startTicks,
      pids: procs.map((p) => p.pid), ports, ageSec: rp.ageSec, rssKB, swapKB, cpuPercent, duplicate: false, protected: prot,
    };
  });

  // Doublons : dans un même projet, même catégorie parmi front/back/worker/db → toutes sauf la plus ancienne.
  // Seules les instances reconnues (correction, commande, port) comptent : une catégorie déduite du package.json
  // (script annexe, outil inconnu) ne doit jamais faire désigner un vrai serveur comme doublon.
  if (projectRoot !== null) {
    const byCat = new Map<Category, InstanceSummary[]>();
    for (const i of instances) {
      if (!DUPLICATE_CATEGORIES.has(i.category) || !DUPLICATE_SOURCES.has(i.source)) continue;
      const list = byCat.get(i.category) ?? [];
      list.push(i);
      byCat.set(i.category, list);
    }
    for (const list of byCat.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => b.ageSec - a.ageSec || a.rootStartTicks - b.rootStartTicks || a.rootPid - b.rootPid);
      for (let k = 1; k < list.length; k++) list[k].duplicate = true;
    }
  }

  const present = new Set(instances.map((i) => i.category));
  return { categories: CATEGORIES.filter((c) => present.has(c)), instances, launcherPids: split.launchers.map((p) => p.pid) };
}

const walk = (n: ProcNode, f: (p: ProcInfo) => void) => {
  const stack = [n];
  while (stack.length) { const c = stack.pop()!; f(c.proc); stack.push(...c.children); }
};

/**
 * Pids qui ont une instance projet parmi leurs descendants en passant par d'autres groupes (ex. `sh -c vite` rangé
 * dans command:sh entre concurrently et vite) : pour chaque racine de groupe projet contenant un nœud reconnu, on
 * remonte la chaîne des parents sur l'ensemble des processus.
 */
function crossGroupAncestors(all: Group[]): Set<number> {
  const marked = new Set<number>();
  const starts: ProcInfo[] = [];
  for (const g of all) {
    if (g.kind !== 'project' && g.kind !== 'deleted') continue;
    for (const r of g.roots) {
      let any = false;
      walk(r, (p) => { if (!any && isMatched(p)) any = true; });
      if (any) starts.push(r.proc);
    }
  }
  if (starts.length === 0) return marked;
  const byPid = new Map<number, ProcInfo>();
  for (const g of all) for (const r of g.roots) walk(r, (p) => byPid.set(p.pid, p));
  for (const s of starts) {
    let cur = s.ppid !== s.pid ? byPid.get(s.ppid) : undefined;
    while (cur && !marked.has(cur.pid)) {
      marked.add(cur.pid);
      cur = cur.ppid !== cur.pid ? byPid.get(cur.ppid) : undefined;
    }
  }
  return marked;
}

/** Classe les instances de chaque groupe (sous-groupes de « Autres » compris), indexé par id de groupe. */
export function classifyGroups(groups: Group[], ctx: ClassifyContext): Map<string, GroupClassification> {
  const all: Group[] = [];
  const collect = (g: Group) => { all.push(g); g.subgroups.forEach(collect); };
  groups.forEach(collect);
  const cross = crossGroupAncestors(all);
  const hasInstanceBelow = (pid: number) => cross.has(pid);
  const out = new Map<string, GroupClassification>();
  for (const g of all) {
    out.set(g.id, g.kind === 'others' ? { categories: [], instances: [], launcherPids: [] } : classifyGroup(g, ctx, hasInstanceBelow));
  }
  return out;
}
