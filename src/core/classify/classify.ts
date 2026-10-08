import type { Group, InstanceSummary } from '../types';
import { CATEGORIES, DUPLICATE_CATEGORIES, type Category } from './categories';
import { findInstances } from './instances';
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
  home: string;
}

export interface GroupClassification { categories: Category[]; instances: InstanceSummary[] }

const matchScript = (script: string): CommandMatch | null => {
  // Un script peut enchaîner plusieurs commandes (« a && b ») : la première qui correspond à une règle.
  const parts = script.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
  return matchCommand(parts.map((cmdline) => ({ name: '', cmdline })));
};

const PROJECT_PREFIX = 'project:';

function classifyGroup(group: Group, ctx: ClassifyContext): GroupClassification {
  const isProject = group.kind === 'project' || group.kind === 'deleted';
  const projectRoot = group.kind === 'project' && group.id.startsWith(PROJECT_PREFIX) ? group.id.slice(PROJECT_PREFIX.length) : null;
  const instances: InstanceSummary[] = findInstances(group).map(({ root, procs }) => {
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
  if (projectRoot !== null) {
    const byCat = new Map<Category, InstanceSummary[]>();
    for (const i of instances) {
      if (!DUPLICATE_CATEGORIES.has(i.category)) continue;
      const list = byCat.get(i.category) ?? [];
      list.push(i);
      byCat.set(i.category, list);
    }
    for (const list of byCat.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => b.ageSec - a.ageSec || a.rootStartTicks - b.rootStartTicks);
      for (let k = 1; k < list.length; k++) list[k].duplicate = true;
    }
  }

  const present = new Set(instances.map((i) => i.category));
  return { categories: CATEGORIES.filter((c) => present.has(c)), instances };
}

/** Classe les instances de chaque groupe (sous-groupes de « Autres » compris), indexé par id de groupe. */
export function classifyGroups(groups: Group[], ctx: ClassifyContext): Map<string, GroupClassification> {
  const out = new Map<string, GroupClassification>();
  const visit = (g: Group) => {
    out.set(g.id, g.kind === 'others' ? { categories: [], instances: [] } : classifyGroup(g, ctx));
    for (const s of g.subgroups) visit(s);
  };
  for (const g of groups) visit(g);
  return out;
}
