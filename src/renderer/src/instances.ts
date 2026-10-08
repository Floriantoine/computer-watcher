// Section « Instances » du détail d'un groupe : tri, mini-courbes, actions groupées d'en-tête, « Reclasser » (fonctions pures).
import { CATEGORIES } from '../../core/classify/categories';
import type { Category, GroupSummary, InstanceSummary } from '../../core/types';
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
