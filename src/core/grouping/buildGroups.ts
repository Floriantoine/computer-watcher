// src/core/grouping/buildGroups.ts
import type { Group, GroupKind, ProcInfo, ProcNode } from '../types';
import { baseName, programIndex, splitArgs } from '../classify/argv';
import { isMcpServer } from '../classify/rules';
import { isUnderAny } from './claudeDirs';
import { projectLabel } from './projectRoot';
import { APP_NAMES, CLAUDE_NAME, DEV_TOOL, appLabel } from './rules';

export interface GroupingOptions {
  home: string;
  currentUid: number;
  isProtected: (name: string) => boolean;
  othersThreshold: { memMB: number; cpuPercent: number };
  projectRootOf: (cwd: string) => string | null;
  /** Groupes à ne pas ranger dans « Autres » même sous les seuils (hystérésis des cartes, voir stickyCards). */
  keepSeparate?: (id: string) => boolean;
  /** Dossiers de config de Claude (voir claudeDirs) : un processus qui y travaille rejoint le groupe Claude. */
  claudeDirs?: readonly string[];
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

  const dirs = opts.claudeDirs ?? [];
  const homeDir = trimSlash(opts.home);
  /** Dossier de projet réel (ni `/`, ni le dossier personnel, ni la config de Claude) ; dossier supprimé compris. */
  const inRealProject = (p: ProcInfo): boolean => {
    if (p.cwd === null || isUnderAny(p.cwd, dirs)) return false;
    const root = p.cwdDeleted ? p.cwd : opts.projectRootOf(p.cwd);
    if (root === null) return false;
    const r = trimSlash(root);
    return r !== '/' && r !== homeDir && !isUnderAny(r, dirs);
  };
  /**
   * Outil Claude : serveur MCP, ou programme pris dans ~/.claude (hook, outil de plugin : `node ~/.claude/plugins/…/x.js`).
   * Seul le programme significatif compte : les shells de l'outil Bash ont tous `source ~/.claude/shell-snapshots/…` en argument.
   */
  const isClaudeTool = (p: ProcInfo): boolean => {
    if (isMcpServer(p.name, p.cmdline)) return true;
    if (dirs.length === 0) return false;
    const raw = splitArgs(p.cmdline);
    return isUnderAny(raw[Math.max(0, programIndex(raw.map(baseName)))] ?? null, dirs);
  };
  const claudeLaunched = new Set<number>();
  const movedRoots: ProcInfo[] = [];

  /** Groupe d'un outil de dev d'après son dossier de travail : projet, dossier supprimé, ou sa commande sans cwd. */
  const devToolKey = (p: ProcInfo): string => {
    if (p.cwdDeleted) {
      meta.set('deleted', { kind: 'deleted', label: '(dossier supprimé)' });
      return 'deleted';
    }
    if (p.cwd === null) {
      const key = `command:${p.name}`;
      meta.set(key, { kind: 'command', label: p.name });
      return key;
    }
    const root = opts.projectRootOf(p.cwd) ?? p.cwd;
    const key = `project:${root}`;
    meta.set(key, { kind: 'project', label: projectLabel(root, opts.home) });
    return key;
  };

  // 1. Sessions Claude : chaque claude de premier niveau et ses descendants, sauf les outils de dev lancés dans un vrai
  // projet (jest, vite, npm run dev…) : eux et tout leur sous-arbre sortent de la carte Claude vers leur projet (1 bis),
  // marqués « lancés par Claude ». Un serveur MCP ou un outil de
  // ~/.claude garde tout son sous-arbre dans Claude.
  for (const p of procs) {
    if (p.name !== CLAUDE_NAME || hasAncestor(p, (a) => a.name === CLAUDE_NAME)) continue;
    meta.set('claude', { kind: 'claude', label: 'Claude' });
    const stack: { p: ProcInfo; tool: boolean }[] = [{ p, tool: false }];
    while (stack.length) {
      const { p: c, tool } = stack.pop()!;
      if (keyOf.has(c.pid) || claudeLaunched.has(c.pid)) continue;
      const inTool = tool || isClaudeTool(c);
      if (c !== p && !inTool && DEV_TOOL.test(c.name) && inRealProject(c)) {
        movedRoots.push(c);
        continue;
      }
      keyOf.set(c.pid, 'claude');
      for (const k of children.get(c.pid) ?? []) stack.push({ p: k, tool: inTool });
    }
  }


  // 1 bis. Chaque outil sorti de Claude emmène tout son sous-arbre dans son projet, tel qu'il était sous Claude
  // (navigateur de Playwright, `sh -c` intermédiaires, workers) : avant les applis, pour qu'un chromium de test ne
  // rejoigne pas la carte Chrome de l'utilisateur (ni son kill). Instances et lanceurs s'y calculent comme d'habitude.
  for (const root of movedRoots) {
    const key = devToolKey(root);
    const before = keyOf.size;
    assignTree(root, key, () => false);
    if (keyOf.size === before) continue;
    const stack = [root];
    while (stack.length) {
      const c = stack.pop()!;
      if (keyOf.get(c.pid) !== key || claudeLaunched.has(c.pid)) continue;
      claudeLaunched.add(c.pid);
      stack.push(...(children.get(c.pid) ?? []));
    }
  }

  // 2. Applis multi-processus : la descente s'arrête aux outils de dev et à claude
  for (const p of procs) {
    if (!APP_NAMES.has(p.name) || keyOf.has(p.pid) || hasAncestor(p, (a) => a.name === p.name)) continue;
    const key = `app:${p.name}`;
    meta.set(key, { kind: 'app', label: appLabel(p.name) });
    assignTree(p, key, (c) => DEV_TOOL.test(c.name) || c.name === CLAUDE_NAME);
  }

  // 2 bis. Outils Claude détachés (serveur du compagnon visuel, MCP, outils de plugins lancés à part) : dossier de
  // travail sous ~/.claude (ou $CLAUDE_CONFIG_DIR), même sans session claude parmi leurs ancêtres. Après les applis :
  // un shell de terminal ou d'éditeur ouvert dans ~/.claude reste dans son appli (seuls les non-affectés sont pris).
  if (dirs.length) {
    for (const p of procs) {
      if (keyOf.has(p.pid) || p.cwdDeleted || !isUnderAny(p.cwd, dirs)) continue;
      meta.set('claude', { kind: 'claude', label: 'Claude' });
      assignTree(p, 'claude', () => false);
    }
  }

  // 3. Outils de dev : par projet
  for (const p of procs) {
    if (keyOf.has(p.pid) || !DEV_TOOL.test(p.name)) continue;
    keyOf.set(p.pid, devToolKey(p));
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

  const groups = [...members].map(([key, list]) => {
    const g = makeGroup(key, meta.get(key)!, list, opts);
    if (claudeLaunched.size) {
      const launched = list.filter((p) => claudeLaunched.has(p.pid)).map((p) => p.pid);
      if (launched.length) g.launchedByClaude = launched;
    }
    return g;
  });
  return applyOthers(groups, opts.othersThreshold, opts.keepSeparate, opts.home);
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
    // Groupe Claude : « claude » même si sa racine la plus grosse est un outil détaché (jamais « Protéger « node » »).
    rootName: kind === 'claude' ? 'claude' : roots[0].proc.name,
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

/** Groupe assez gros (mémoire) ou actif (CPU) pour avoir sa carte par lui-même, sans l'hystérésis. */
export function isOverThreshold(g: { rssKB: number; swapKB: number; cpuPercent: number }, t: { memMB: number; cpuPercent: number }): boolean {
  return mem(g) >= t.memMB * 1024 || g.cpuPercent >= t.cpuPercent;
}

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/**
 * Projets et dossiers supprimés gardent toujours leur carte : leurs instances (serveurs de dev oubliés, souvent petits et
 * inactifs) doivent rester visibles pour le filtre par catégorie et « Tuer la sélection ». Seulement pour une vraie racine
 * de projet : un « projet » qui est le dossier personnel ou `/` (processus lancés depuis là) suit le seuil normal.
 */
function alwaysOwnCard(g: Group, home: string): boolean {
  if (g.kind === 'deleted') return true;
  if (g.kind !== 'project') return false;
  const root = trimSlash(g.id.slice('project:'.length));
  return root !== '/' && root !== trimSlash(home);
}

function applyOthers(groups: Group[], t: { memMB: number; cpuPercent: number }, keepSeparate: ((id: string) => boolean) | undefined, home: string): Group[] {
  const isSmall = (g: Group) => !alwaysOwnCard(g, home) && !isOverThreshold(g, t) && !keepSeparate?.(g.id);
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
