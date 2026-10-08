import type { GroupClassification } from './classify/classify';
import type { Group, GroupSummary, InstanceTargets, KillTarget, MemoryMetric, ProcInfo, ProcNode, Snapshot, SystemInfo, Watch } from './types';

export type Classification = Map<string, GroupClassification>;

/** Groupe sans arbre : le renderer n'a besoin des processus que pour le groupe ouvert. Catégories et instances d'après `cls`. */
export function summarizeGroup(g: Group, cls?: Classification, pss = false): GroupSummary {
  const { roots: _roots, subgroups, ...rest } = g;
  const c = cls?.get(g.id);
  const out: GroupSummary = { ...rest, subgroups: subgroups.map((s) => summarizeGroup(s, cls, pss)), categories: c?.categories ?? [], instances: c?.instances ?? [] };
  if (pss) {
    const n = rssFallbackCount(g);
    if (n > 0) out.pssFallback = n;
  }
  return out;
}

/** « Autres » replié : sans ses sous-groupes, mais le compte des processus restés en RSS porte sur le groupe complet. */
function foldedOthers(g: Group, cls: Classification, pss: boolean): GroupSummary {
  const out = summarizeGroup({ ...g, subgroups: [] }, cls);
  if (pss) {
    const n = rssFallbackCount(g);
    if (n > 0) out.pssFallback = n;
  }
  return out;
}

/** Processus d'un groupe (sous-groupes compris) dont la mémoire est restée en RSS en mode PSS. */
function rssFallbackCount(g: Group): number {
  let n = 0;
  const walk = (nodes: ProcNode[]) => {
    for (const node of nodes) {
      if (node.proc.pssDenied || node.proc.pssPending) n++;
      walk(node.children);
    }
  };
  walk(g.roots);
  for (const s of g.subgroups) n += rssFallbackCount(s);
  return n;
}

function flattenNodes(nodes: ProcNode[], out: ProcInfo[]): ProcInfo[] {
  for (const n of nodes) {
    out.push(n.proc);
    flattenNodes(n.children, out);
  }
  return out;
}

/** Tous les processus d'un groupe, sous-groupes compris. */
export function flattenGroup(g: Group): ProcInfo[] {
  return [...flattenNodes(g.roots, []), ...g.subgroups.flatMap(flattenGroup)];
}

/** Recherche plein texte : libellé, ligne de commande ou dossier d'un processus (`query` déjà en minuscules ou non, la casse est ignorée). */
export function groupMatches(g: Group, query: string): boolean {
  const q = query.toLowerCase();
  if (!q || g.label.toLowerCase().includes(q)) return true;
  return flattenGroup(g).some((p) => p.cmdline.toLowerCase().includes(q) || (p.cwd ?? '').toLowerCase().includes(q));
}

export function findFullGroup(groups: Group[], id: string): Group | undefined {
  for (const g of groups) {
    if (g.id === id) return g;
    const inner = findFullGroup(g.subgroups, id);
    if (inner) return inner;
  }
  return undefined;
}

/** Le groupe suivi est « Autres » ou l'un de ses sous-groupes : leur classement doit alors être calculé. */
export function followsOthers(groups: Group[], id: string | null): boolean {
  if (id === null) return false;
  return groups.some((g) => g.kind === 'others' && (g.id === id || findFullGroup(g.subgroups, id) !== undefined));
}

/** Sous-groupes de « Autres » à résumer et à classer : carte « Autres » dépliée, ou « Autres » / l'un d'eux suivi. */
export function othersFollowed(groups: Group[], watch: Watch): boolean {
  return watch.othersOpen === true || followsOthers(groups, watch.groupId);
}

/** Processus du groupe `id` (vide s'il n'existe plus) : sert à préparer un kill de groupe. */
export function groupProcs(groups: Group[], id: string): ProcInfo[] {
  const g = findFullGroup(groups, id);
  return g ? flattenGroup(g) : [];
}

export interface FullSnapshot {
  takenAt: number;
  currentUid: number;
  system: SystemInfo;
  groups: Group[];
  /** Classement par id de groupe (sous-groupes de « Autres » compris), lanceurs compris. */
  classification: Classification;
  /** Mémoire des processus et groupes : PSS si 'pss' (absent → 'rss'). */
  memMetric?: MemoryMetric;
}

/**
 * Snapshot envoyé au renderer : résumés de groupes, résultat de la recherche et arbre du seul groupe suivi.
 * Les centaines de sous-groupes de « Autres » ne sont résumés que si « Autres » est déplié, ou lui ou l'un d'eux suivi.
 */
export function buildSnapshot(full: FullSnapshot, watch: Watch): Snapshot {
  const query = watch.query.trim();
  const followed = watch.groupId === null ? undefined : findFullGroup(full.groups, watch.groupId);
  const pss = full.memMetric === 'pss';
  const inOthers = (g: Group) => watch.othersOpen === true || (!!followed && (followed === g || g.subgroups.includes(followed)));
  return {
    takenAt: full.takenAt,
    currentUid: full.currentUid,
    system: full.system,
    groups: full.groups.map((g) =>
      g.kind === 'others' && !inOthers(g) ? foldedOthers(g, full.classification, pss) : summarizeGroup(g, full.classification, pss),
    ),
    groupIds: full.groups.flatMap((g) => [g.id, ...g.subgroups.map((s) => s.id)]),
    query,
    matches: query ? full.groups.filter((g) => groupMatches(g, query)).map((g) => g.id) : null,
    watched: watch.groupId,
    detail: followed ? { groupId: followed.id, roots: followed.roots } : null,
    memMetric: full.memMetric ?? 'rss',
  };
}

/**
 * Cibles de kill depuis le dernier snapshot complet : pour une clé d'instance (`${groupId}#${rootPid}:${rootStartTicks}`),
 * tous ses processus ; pour une clé de groupe, ses lanceurs (à ajouter au kill « Tout arrêter » du projet) et les clés des
 * instances qu'ils couvrent (`covers`), pour que le renderer ne les envoie que si toutes sont cochées. `names` : nom de chaque cible.
 * Les clés inconnues (instance disparue) sont absentes du résultat.
 */
export function instanceTargets(full: FullSnapshot, keys: string[]): InstanceTargets[] {
  const byKey = new Map<string, { groupId: string; pids: number[] }>();
  for (const [groupId, c] of full.classification) for (const i of c.instances) byKey.set(i.key, { groupId, pids: i.pids });
  const procsOf = new Map<string, Map<number, ProcInfo>>();
  const procs = (groupId: string) => {
    let m = procsOf.get(groupId);
    if (!m) {
      m = new Map(groupProcs(full.groups, groupId).map((p) => [p.pid, p]));
      procsOf.set(groupId, m);
    }
    return m;
  };
  const toTargets = (groupId: string, pids: number[]): { targets: KillTarget[]; names: string[] } => {
    const targets: KillTarget[] = [];
    const names: string[] = [];
    for (const pid of pids) {
      const p = procs(groupId).get(pid);
      if (!p) continue;
      targets.push({ pid, startTicks: p.startTicks });
      names.push(p.name);
    }
    return { targets, names };
  };
  let ppidOf: Map<number, number> | undefined;
  // Instances (tous groupes) dont la racine descend d'un des lanceurs : tuer le lanceur peut les emporter.
  const coveredBy = (launchers: readonly number[]): string[] => {
    if (!launchers.length) return [];
    ppidOf ??= new Map(full.groups.flatMap(flattenGroup).map((p) => [p.pid, p.ppid]));
    const set = new Set(launchers);
    const out: string[] = [];
    for (const c of full.classification.values()) {
      for (const i of c.instances) {
        const seen = new Set<number>();
        for (let cur = ppidOf.get(i.rootPid); cur !== undefined && cur > 1 && !seen.has(cur); cur = ppidOf.get(cur)) {
          if (set.has(cur)) {
            out.push(i.key);
            break;
          }
          seen.add(cur);
        }
      }
    }
    return out;
  };
  const out: InstanceTargets[] = [];
  for (const key of keys) {
    const inst = byKey.get(key);
    if (inst) {
      out.push({ key, ...toTargets(inst.groupId, inst.pids) });
      continue;
    }
    const g = full.classification.get(key);
    if (g) {
      const t = toTargets(key, g.launcherPids);
      out.push({ key, ...t, covers: coveredBy(t.targets.map((x) => x.pid)) });
    }
  }
  return out;
}

export const MAX_QUERY = 1000;

export const isWatch = (w: unknown): w is Watch =>
  typeof w === 'object' &&
  w !== null &&
  ((w as Watch).groupId === null || typeof (w as Watch).groupId === 'string') &&
  typeof (w as Watch).query === 'string' &&
  (w as Watch).query.length <= MAX_QUERY &&
  ((w as Watch).othersOpen === undefined || typeof (w as Watch).othersOpen === 'boolean');
