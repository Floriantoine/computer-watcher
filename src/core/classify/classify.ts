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
  }
  return { category: 'unknown', source: 'unknown' };
}

export interface ClassifyContext {
  overrides: Record<string, Category>;
  /** Ports en écoute par pid (vide si non lus) */
  ports: Map<number, number[]>;
  pkg: (projectRoot: string) => PackageHints | null;
  isProtected: (name: string) => boolean;
  /**
   * Cache facultatif des décisions par instance (clé : groupe, racine, empreinte des `pid:startTicks` de l'instance). L'appelant le vide quand les
   * corrections ou les ports changent (et périodiquement, pour le cache de package.json) ; les entrées non revues sont retirées.
   */
  memo?: Map<string, InstanceDecision>;
}

export interface InstanceDecision { category: Category; source: InstanceSummary['source']; signature: string; label: string }

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

/**
 * Empreinte (FNV-1a 32 bits) de la liste triée des `pid:startTicks` d'une instance : la décision en cache est revue
 * dès qu'un processus de l'instance change, même à nombre égal (enfant remplacé).
 */
function procsHash(procs: ProcInfo[]): string {
  const ids = procs.map((p) => [p.pid, p.startTicks] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let h = 0x811c9dc5;
  const mix = (n: number) => {
    // chaque nombre en deux mots de 32 bits (startTicks peut dépasser 2^32 ticks)
    for (const part of [n >>> 0, Math.floor(n / 0x1_0000_0000) >>> 0]) {
      for (let s = 0; s < 32; s += 8) h = Math.imul(h ^ ((part >>> s) & 0xff), 0x01000193);
    }
  };
  for (const [pid, st] of ids) { mix(pid); mix(st); }
  return (h >>> 0).toString(36);
}

const PROJECT_PREFIX = 'project:';
const DUPLICATE_SOURCES: ReadonlySet<InstanceSummary['source']> = new Set(['manual', 'command', 'port']);

function classifyGroup(group: Group, ctx: ClassifyContext, hasInstanceBelow: (pid: number) => boolean, used: Set<string> | null): GroupClassification {
  const isProject = group.kind === 'project' || group.kind === 'deleted';
  const projectRoot = group.kind === 'project' && group.id.startsWith(PROJECT_PREFIX) ? group.id.slice(PROJECT_PREFIX.length) : null;
  const split = splitInstances(group, hasInstanceBelow);
  const instances: InstanceSummary[] = split.instances.map(({ root, procs }) => {
    const rp = root.proc;
    const portSet = new Set<number>();
    if (ctx.ports.size > 0) for (const p of procs) for (const port of ctx.ports.get(p.pid) ?? []) portSet.add(port);
    const ports = [...portSet].sort((a, b) => a - b);
    const memoKey = `${group.id}#${rp.pid}:${rp.startTicks}|${procs.length}:${procsHash(procs)}`;
    let dec = ctx.memo?.get(memoKey);
    if (!dec) {
      const match = isProject ? matchCommand(procs) : classifyByName(rp.name, rp.cmdline);
      const signature = signatureOf(procs, match, projectRoot);
      const overrideKey = `${projectRoot ?? group.id}|${signature}`;
      const pkg = projectRoot !== null && match === null ? ctx.pkg(projectRoot) : null;
      const d = decide({ overrideKey, overrides: ctx.overrides, match, ports, chainText: signature, pkg, matchScript });
      dec = { category: d.category, source: d.source === 'command' && !isProject ? 'name' : d.source, signature, label: match?.label ?? signature };
      ctx.memo?.set(memoKey, dec);
    }
    used?.add(memoKey);
    let rssKB = 0; let swapKB = 0; let cpuPercent = 0; let prot = false;
    for (const p of procs) {
      rssKB += p.rssKB; swapKB += p.swapKB; cpuPercent += p.cpuPercent;
      if (!prot && ctx.isProtected(p.name)) prot = true;
    }
    return {
      key: `${group.id}#${rp.pid}:${rp.startTicks}`, groupId: group.id, project: projectRoot,
      category: dec.category, source: dec.source,
      signature: dec.signature, label: dec.label, rootPid: rp.pid, rootStartTicks: rp.startTicks,
      pids: procs.map((p) => p.pid), ports, ageSec: rp.ageSec, rssKB, swapKB, cpuPercent, duplicate: false, protected: prot,
    };
  });

  // Doublons : dans un même projet, même catégorie parmi front/back/worker/db ET même commande (signature)
  // → toutes sauf la plus ancienne. Une API et un worker, ou deux apps d'un monorepo, ne sont pas des doublons.
  // Seules les instances reconnues (correction, commande, port) comptent : une catégorie déduite du package.json
  // (script annexe, outil inconnu) ne doit jamais faire désigner un vrai serveur comme doublon.
  if (projectRoot !== null) {
    const byCat = new Map<string, InstanceSummary[]>();
    for (const i of instances) {
      if (!DUPLICATE_CATEGORIES.has(i.category) || !DUPLICATE_SOURCES.has(i.source)) continue;
      const k = `${i.category}|${i.signature}`;
      const list = byCat.get(k) ?? [];
      list.push(i);
      byCat.set(k, list);
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
  const used = ctx.memo ? new Set<string>() : null;
  for (const g of all) {
    out.set(g.id, g.kind === 'others' ? { categories: [], instances: [], launcherPids: [] } : classifyGroup(g, ctx, hasInstanceBelow, used));
  }
  if (ctx.memo && used) for (const k of ctx.memo.keys()) if (!used.has(k)) ctx.memo.delete(k);
  return out;
}
