import type { GroupClassification } from './classify/classify';
import type { Group, GroupSummary, KillTarget, ProcInfo, ProcNode, Snapshot, SystemInfo, Watch } from './types';

export type Classification = Map<string, GroupClassification>;

/** Groupe sans arbre : le renderer n'a besoin des processus que pour le groupe ouvert. Catégories et instances d'après `cls`. */
export function summarizeGroup(g: Group, cls?: Classification): GroupSummary {
  const { roots: _roots, subgroups, ...rest } = g;
  const c = cls?.get(g.id);
  return { ...rest, subgroups: subgroups.map((s) => summarizeGroup(s, cls)), categories: c?.categories ?? [], instances: c?.instances ?? [] };
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
}

/**
 * Snapshot envoyé au renderer : résumés de groupes, résultat de la recherche et arbre du seul groupe suivi.
 * Les centaines de sous-groupes de « Autres » ne sont résumés que si « Autres » ou l'un d'eux est suivi.
 */
export function buildSnapshot(full: FullSnapshot, watch: Watch): Snapshot {
  const query = watch.query.trim();
  const followed = watch.groupId === null ? undefined : findFullGroup(full.groups, watch.groupId);
  const inOthers = (g: Group) => !!followed && (followed === g || g.subgroups.includes(followed));
  return {
    takenAt: full.takenAt,
    currentUid: full.currentUid,
    system: full.system,
    groups: full.groups.map((g) =>
      g.kind === 'others' && !inOthers(g) ? summarizeGroup({ ...g, subgroups: [] }, full.classification) : summarizeGroup(g, full.classification),
    ),
    groupIds: full.groups.flatMap((g) => [g.id, ...g.subgroups.map((s) => s.id)]),
    query,
    matches: query ? full.groups.filter((g) => groupMatches(g, query)).map((g) => g.id) : null,
    watched: watch.groupId,
    detail: followed ? { groupId: followed.id, roots: followed.roots } : null,
  };
}

/**
 * Cibles de kill depuis le dernier snapshot complet : pour une clé d'instance (`${groupId}#${rootPid}:${rootStartTicks}`),
 * tous ses processus ; pour une clé de groupe, ses lanceurs (à ajouter au kill « Tout arrêter » du projet).
 * Les clés inconnues (instance disparue) sont absentes du résultat.
 */
export function instanceTargets(full: FullSnapshot, keys: string[]): { key: string; targets: KillTarget[] }[] {
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
  const toTargets = (groupId: string, pids: number[]): KillTarget[] =>
    pids.flatMap((pid) => {
      const p = procs(groupId).get(pid);
      return p ? [{ pid, startTicks: p.startTicks }] : [];
    });
  const out: { key: string; targets: KillTarget[] }[] = [];
  for (const key of keys) {
    const inst = byKey.get(key);
    if (inst) {
      out.push({ key, targets: toTargets(inst.groupId, inst.pids) });
      continue;
    }
    const g = full.classification.get(key);
    if (g) out.push({ key, targets: toTargets(key, g.launcherPids) });
  }
  return out;
}

export const MAX_QUERY = 1000;

export const isWatch = (w: unknown): w is Watch =>
  typeof w === 'object' &&
  w !== null &&
  ((w as Watch).groupId === null || typeof (w as Watch).groupId === 'string') &&
  typeof (w as Watch).query === 'string' &&
  (w as Watch).query.length <= MAX_QUERY;
