// Section « Instances » du détail d'un groupe : tri, mini-courbes, actions groupées d'en-tête, « Reclasser » (fonctions pures).
import { CATEGORIES } from '../../core/classify/categories';
import type { Category, GroupSummary, InstanceSummary, KillTarget, ProcInfo, ProcNode } from '../../core/types';
import { sameSeries } from './renderEquality';
import { killRequestForInstance, type KillRequest } from './viewModel';
import { CATEGORY_META } from './categories';

/** Ordre affiché : ordre des catégories, puis la plus ancienne d'abord (l'originale avant ses doublons). */
export function sortInstances(list: readonly InstanceSummary[]): InstanceSummary[] {
  return [...list].sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || b.ageSec - a.ageSec || a.rootPid - b.rootPid);
}

/**
 * Mini-courbe mémoire d'une instance : somme point à point des séries déjà chargées pour l'arbre (`procSparkMap`),
 * pour ses processus identifiés par pid + startTicks (`ticksOf` vient de l'arbre ; la racine est connue sans lui).
 * Aucune requête de plus. undefined si aucun de ses processus n'a d'historique.
 */
export function instanceSpark(
  inst: InstanceSummary,
  sparks: ReadonlyMap<string, (number | null)[]>,
  ticksOf: ReadonlyMap<number, number>,
): (number | null)[] | undefined {
  let out: (number | null)[] | undefined;
  for (const pid of inst.pids) {
    const ticks = pid === inst.rootPid ? inst.rootStartTicks : ticksOf.get(pid);
    if (ticks === undefined) continue;
    const s = sparks.get(`${pid}:${ticks}`);
    if (!s) continue;
    if (!out) out = s.slice();
    else for (let i = 0; i < out.length; i++) {
      const v = s[i];
      if (v !== null && v !== undefined) out[i] = (out[i] ?? 0) + v;
    }
  }
  return out;
}

export interface HeaderKillAction {
  id: 'front' | 'back' | 'all';
  label: string;
  /** Instances proposées au dialogue groupé, protégées comprises (il les décoche). */
  instances: InstanceSummary[];
  /** « Tout arrêter » : id du groupe dont les lanceurs (npm, sh…) sont ajoutés via `instances:targets([id])`. */
  launchersOf?: string;
}

/** Boutons d'en-tête de la section : « Tuer le front », « Tuer le back » selon les catégories présentes, et « Tout arrêter ». */
export function headerKillActions(g: GroupSummary): HeaderKillAction[] {
  if ((g.kind !== 'project' && g.kind !== 'deleted') || !g.killable || g.instances.length === 0) return [];
  const out: HeaderKillAction[] = [];
  for (const [id, label] of [['front', 'Tuer le front'], ['back', 'Tuer le back']] as const) {
    const list = g.instances.filter((i) => i.category === id);
    if (list.length) out.push({ id, label, instances: list });
  }
  out.push({ id: 'all', label: 'Tout arrêter', instances: [...g.instances], launchersOf: g.id });
  return out;
}

/** Portée d'une correction manuelle (`classify:set`) : racine du projet, sinon id du groupe. */
export const reclassifyScope = (inst: InstanceSummary): string => inst.project ?? inst.groupId;

/** Nom court pour les messages : dernier segment de la racine du projet, sinon libellé du groupe. */
export function projectName(inst: InstanceSummary, groupLabel: string): string {
  const seg = inst.project?.split('/').filter(Boolean).pop();
  return seg || groupLabel;
}

export const reclassifyMessage = (cat: Category | null, name: string): string =>
  cat ? `Classée comme ${CATEGORY_META[cat].label} pour ${name}` : `Classement automatique rétabli pour ${name}`;

/** « Revenir à l'automatique » n'est proposé que pour une correction manuelle. */
export const showRevertToAuto = (inst: InstanceSummary): boolean => inst.source === 'manual';

/** Navigation clavier du menu : flèches (circulaires), Début, Fin ; null pour une autre touche. */
export function menuIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  if (key === 'ArrowDown') return current < 0 ? 0 : (current + 1) % count;
  if (key === 'ArrowUp') return current <= 0 ? count - 1 : current - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/**
 * Kill d'une instance : `entries` = réponse de `instances:targets([inst.key])`, `all` = processus du groupe.
 * Distingue l'instance disparue (clé absente, processus remplacés) de celle dont aucun processus n'est à l'utilisateur.
 */
export function instanceKillPlan(
  inst: InstanceSummary,
  entries: { key: string; targets: KillTarget[] }[],
  all: ProcInfo[],
  isProtected: (n: string) => boolean,
  currentUid: number,
): { request: KillRequest } | { error: string } {
  const targets = entries.find((e) => e.key === inst.key)?.targets ?? [];
  const request = killRequestForInstance(inst, targets, all, isProtected, currentUid);
  if (request.targets.length) return { request };
  const byPid = new Map(all.map((p) => [p.pid, p]));
  const foreign = targets.some((t) => {
    const p = byPid.get(t.pid);
    return p !== undefined && p.startTicks === t.startTicks && p.uid !== currentUid;
  });
  return { error: foreign ? 'Les processus de cette instance appartiennent à un autre utilisateur' : "Cette instance n'existe plus" };
}

/** Double clic : demande déjà en cours pour cette instance, ou SIGTERM déjà envoyé à tous ses processus. */
export const skipInstanceKill = (inst: InstanceSummary, inFlight: ReadonlySet<string>, pendingPids: { has(pid: number): boolean }): boolean =>
  inFlight.has(inst.key) || (inst.pids.length > 0 && inst.pids.every((p) => pendingPids.has(p)));

/** pid → startTicks de l'arbre ; renvoie `prev` si le contenu n'a pas changé (identité stable entre snapshots). */
export function ticksIndex(roots: readonly ProcNode[] | null, prev: Map<number, number> | undefined): Map<number, number> {
  const out = new Map<number, number>();
  const walk = (ns: readonly ProcNode[]) => {
    for (const n of ns) {
      out.set(n.proc.pid, n.proc.startTicks);
      walk(n.children);
    }
  };
  if (roots) walk(roots);
  if (prev && prev.size === out.size && [...out].every(([k, v]) => prev.get(k) === v)) return prev;
  return out;
}

export interface InstanceRowView {
  inst: InstanceSummary;
  spark: (number | null)[] | undefined;
  stuck: number[];
  pending: boolean;
  canKill: boolean;
  menuOpen: boolean;
}

const sameNums = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Comparateur du memo d'une ligne : seulement ce qu'elle affiche (le reste des callbacks est stable). */
export function instanceRowEqual(a: InstanceRowView, b: InstanceRowView): boolean {
  const x = a.inst;
  const y = b.inst;
  return (
    x.key === y.key && x.category === y.category && x.source === y.source && x.label === y.label && x.duplicate === y.duplicate && x.launchedBy === y.launchedBy &&
    x.ageSec === y.ageSec && x.rssKB === y.rssKB && x.swapKB === y.swapKB && x.cpuPercent === y.cpuPercent && x.signature === y.signature &&
    x.protected === y.protected && x.project === y.project && x.groupId === y.groupId &&
    sameNums(x.ports, y.ports) && sameNums(x.pids, y.pids) &&
    sameSeries(a.spark, b.spark) && sameNums(a.stuck, b.stuck) &&
    a.pending === b.pending && a.canKill === b.canKill && a.menuOpen === b.menuOpen
  );
}
