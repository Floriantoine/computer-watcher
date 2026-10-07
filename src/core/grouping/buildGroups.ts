// src/core/grouping/buildGroups.ts
import type { Group, GroupKind, ProcInfo, ProcNode } from '../types';
import { projectLabel } from './projectRoot';
import { APP_NAMES, CLAUDE_NAME, DEV_TOOL, appLabel } from './rules';

export interface GroupingOptions {
  home: string;
  currentUid: number;
  isProtected: (name: string) => boolean;
  othersThreshold: { memMB: number; cpuPercent: number };
  projectRootOf: (cwd: string) => string | null;
}

interface Meta {
  kind: GroupKind;
  label: string;
}

const mem = (x: { rssKB: number; swapKB: number }) => x.rssKB + x.swapKB;
const byMemDesc = (a: Group, b: Group) => mem(b) - mem(a);

export function buildGroups(procs: ProcInfo[], opts: GroupingOptions): Group[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const children = new Map<number, ProcInfo[]>();
  for (const p of procs) {
    if (p.ppid === p.pid) continue;
    const list = children.get(p.ppid) ?? [];
    list.push(p);
    children.set(p.ppid, list);
  }

  const keyOf = new Map<number, string>();
  const meta = new Map<string, Meta>();

  const hasAncestor = (p: ProcInfo, pred: (a: ProcInfo) => boolean): boolean => {
    const seen = new Set<number>();
    let cur = byPid.get(p.ppid);
    while (cur && !seen.has(cur.pid)) {
      if (pred(cur)) return true;
      seen.add(cur.pid);
      cur = byPid.get(cur.ppid);
    }
    return false;
  };

  const assignTree = (root: ProcInfo, key: string, stop: (p: ProcInfo) => boolean) => {
    const stack = [root];
    while (stack.length) {
      const p = stack.pop()!;
      if (keyOf.has(p.pid)) continue;
      if (p !== root && stop(p)) continue;
      keyOf.set(p.pid, key);
      stack.push(...(children.get(p.pid) ?? []));
    }
  };

  // 1. Sessions Claude : chaque claude de premier niveau et tous ses descendants
  for (const p of procs) {
    if (p.name === CLAUDE_NAME && !hasAncestor(p, (a) => a.name === CLAUDE_NAME)) {
      meta.set('claude', { kind: 'claude', label: 'Claude' });
      assignTree(p, 'claude', () => false);
    }
  }

  // 2. Applis multi-processus : la descente s'arrête aux outils de dev et à claude
  for (const p of procs) {
    if (!APP_NAMES.has(p.name) || keyOf.has(p.pid) || hasAncestor(p, (a) => a.name === p.name)) continue;
    const key = `app:${p.name}`;
    meta.set(key, { kind: 'app', label: appLabel(p.name) });
    assignTree(p, key, (c) => DEV_TOOL.test(c.name) || c.name === CLAUDE_NAME);
  }

  // 3. Outils de dev : par projet
  for (const p of procs) {
    if (keyOf.has(p.pid) || !DEV_TOOL.test(p.name)) continue;
    let key: string;
    if (p.cwdDeleted) {
      key = 'deleted';
      meta.set(key, { kind: 'deleted', label: '(dossier supprimé)' });
    } else if (p.cwd === null) {
      key = `command:${p.name}`;
      meta.set(key, { kind: 'command', label: p.name });
    } else {
      const root = opts.projectRootOf(p.cwd) ?? p.cwd;
      key = `project:${root}`;
      meta.set(key, { kind: 'project', label: projectLabel(root, opts.home) });
    }
    keyOf.set(p.pid, key);
  }

  // 4. Le reste : par nom
  for (const p of procs) {
    if (keyOf.has(p.pid)) continue;
    const key = `command:${p.name}`;
    meta.set(key, { kind: 'command', label: p.name });
    keyOf.set(p.pid, key);
  }

  const members = new Map<string, ProcInfo[]>();
  for (const p of procs) {
    const key = keyOf.get(p.pid)!;
    const list = members.get(key) ?? [];
    list.push(p);
    members.set(key, list);
  }

  const groups = [...members].map(([key, list]) => makeGroup(key, meta.get(key)!, list, opts));
  return applyOthers(groups, opts.othersThreshold);
}

function makeGroup(id: string, { kind, label }: Meta, list: ProcInfo[], opts: GroupingOptions): Group {
  const nodes = new Map<number, ProcNode>(list.map((p) => [p.pid, { proc: p, children: [] }]));
  const roots: ProcNode[] = [];
  for (const p of list) {
    const node = nodes.get(p.pid)!;
    const parent = p.ppid !== p.pid ? nodes.get(p.ppid) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  if (roots.length === 0) {
    // Cycle de ppid : tous les membres ont leur parent dans le groupe. On casse le cycle sur le premier.
    const first = nodes.get(list[0]!.pid)!;
    const parent = nodes.get(list[0]!.ppid);
    if (parent) parent.children = parent.children.filter((c) => c !== first);
    roots.push(first);
  }
  const sortNodes = (ns: ProcNode[]) => {
    ns.sort((a, b) => mem(b.proc) - mem(a.proc));
    ns.forEach((n) => sortNodes(n.children));
  };
  sortNodes(roots);

  return {
    id,
    kind,
    label,
    tags: kind === 'project' || kind === 'deleted' ? [...new Set(list.map((p) => p.name))] : [],
    rootName: roots[0].proc.name,
    roots,
    pids: list.map((p) => p.pid),
    procCount: list.length,
    cpuPercent: list.reduce((s, p) => s + p.cpuPercent, 0),
    rssKB: list.reduce((s, p) => s + p.rssKB, 0),
    swapKB: list.reduce((s, p) => s + p.swapKB, 0),
    oldestAgeSec: Math.max(...list.map((p) => p.ageSec)),
    protected: list.some((p) => opts.isProtected(p.name)),
    killable: list.some((p) => p.uid === opts.currentUid),
    subgroups: [],
  };
}

function applyOthers(groups: Group[], t: { memMB: number; cpuPercent: number }): Group[] {
  const isSmall = (g: Group) => mem(g) < t.memMB * 1024 && g.cpuPercent < t.cpuPercent;
  const small = groups.filter(isSmall).sort(byMemDesc);
  if (small.length < 2) return groups.sort(byMemDesc);
  const big = groups.filter((g) => !isSmall(g)).sort(byMemDesc);
  const sum = (f: (g: Group) => number) => small.reduce((s, g) => s + f(g), 0);
  const others: Group = {
    id: 'others',
    kind: 'others',
    label: `Autres (${small.length} groupes)`,
    tags: [],
    rootName: '',
    roots: [],
    pids: small.flatMap((g) => g.pids),
    procCount: sum((g) => g.procCount),
    cpuPercent: sum((g) => g.cpuPercent),
    rssKB: sum((g) => g.rssKB),
    swapKB: sum((g) => g.swapKB),
    oldestAgeSec: Math.max(...small.map((g) => g.oldestAgeSec)),
    protected: small.some((g) => g.protected),
    killable: small.some((g) => g.killable),
    subgroups: small,
  };
  return [...big, others];
}
