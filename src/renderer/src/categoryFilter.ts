// Filtre par catégorie de la page Processus, étiquettes et résumé des instances : fonctions pures.
import { CATEGORIES, isCategory } from '../../core/classify/categories';
import type { Category, GroupSummary, InstanceSummary } from '../../core/types';
import { CATEGORY_META } from './categories';

const rank = (c: Category) => CATEGORIES.indexOf(c);

/** Nombre d'instances par catégorie sur les groupes affichables (« Autres » exclu). */
export function countByCategory(groups: readonly GroupSummary[]): Map<Category, number> {
  const out = new Map<Category, number>();
  for (const g of groups) {
    if (g.kind === 'others') continue;
    for (const i of g.instances) out.set(i.category, (out.get(i.category) ?? 0) + 1);
  }
  return out;
}

/** Groupes dont au moins une catégorie est sélectionnée ; sélection vide → `groups` tel quel. « Autres » n'est jamais retenu par un filtre. */
export function filterGroups(groups: GroupSummary[], selected: ReadonlySet<Category>): GroupSummary[] {
  if (selected.size === 0) return groups;
  return groups.filter((g) => g.kind !== 'others' && g.categories.some((c) => selected.has(c)));
}

/**
 * Instances proposées par « Tuer la sélection » : catégories sélectionnées, dans les groupes projet et « dossier supprimé »
 * seulement (applis, Claude, commandes et services restent visibles sous le filtre mais ne sont jamais visés), qui contiennent
 * des processus de l'utilisateur (`killable`). Les protégées sont incluses : le dialogue les liste décochées. Les pids réels
 * et les garde-fous (uid, startTicks) restent côté main.
 */
export function selectionCandidates(groups: readonly GroupSummary[], selected: ReadonlySet<Category>): InstanceSummary[] {
  if (selected.size === 0) return [];
  const out: InstanceSummary[] = [];
  for (const g of groups) {
    if ((g.kind !== 'project' && g.kind !== 'deleted') || !g.killable) continue;
    for (const i of g.instances) if (selected.has(i.category)) out.push(i);
  }
  return out;
}

/** n du bouton : instances cochées par défaut, donc hors protégées. */
export const killCount = (candidates: readonly InstanceSummary[]): number => candidates.reduce((n, i) => n + (i.protected ? 0 : 1), 0);

/** Le bouton « Tuer la sélection » n'apparaît qu'avec un filtre actif et au moins une cible. */
export const showKillSelection = (selected: ReadonlySet<Category>, n: number): boolean => selected.size > 0 && n > 0;

/** Filtre actif sans aucune instance de projet candidate : la barre rappelle que le kill groupé ne vise que les projets. */
export const showProjectsOnlyHint = (selected: ReadonlySet<Category>, candidates: readonly InstanceSummary[]): boolean =>
  selected.size > 0 && candidates.length === 0;

/** Pastilles affichées : catégories présentes, plus les sélectionnées tombées à 0 (sinon impossible de les retirer). */
export const pillCategories = (counts: ReadonlyMap<Category, number>, selected: ReadonlySet<Category>): Category[] =>
  CATEGORIES.filter((c) => counts.has(c) || selected.has(c));

/** Nom accessible d'une pastille : « Front, 1 instance ». */
export const pillLabel = (c: Category, n: number): string => `${CATEGORY_META[c].label}, ${n} instance${n > 1 ? 's' : ''}`;

/** Port principal d'une instance : le plus petit port en écoute (3000 plutôt que 9229 de l'inspecteur). */
const mainPort = (i: InstanceSummary): number | null => (i.ports.length ? Math.min(...i.ports) : null);

export interface PrimaryTag {
  category: Category;
  port: number | null;
}

/** Ordre de préférence à catégorie égale : une instance qui écoute, puis l'instance d'origine plutôt qu'un doublon. */
const weight = (i: InstanceSummary) => (i.ports.length ? 0 : 2) + (i.duplicate ? 1 : 0);

/** Étiquette affichée près du nom : catégorie la plus significative (ordre de CATEGORIES), puis `weight` ; « Inconnu » n'est pas affiché. */
export function primaryTag(g: GroupSummary): PrimaryTag | null {
  let best: InstanceSummary | null = null;
  for (const i of g.instances) {
    if (i.category === 'unknown') continue;
    if (!best || rank(i.category) < rank(best.category) || (i.category === best.category && weight(i) < weight(best))) best = i;
  }
  return best ? { category: best.category, port: mainPort(best) } : null;
}

/**
 * Résumé d'une carte projet : « 1 front :5173 · 2 back :3000 :3001 » (au plus 2 ports par catégorie). Les instances inconnues
 * sans port (scripts, outils) n'y figurent pas ; une inconnue qui écoute reste (« 1 inconnu :7000 »). Chaîne vide si rien.
 */
export function instancesLine(g: GroupSummary): string {
  const by = new Map<Category, InstanceSummary[]>();
  for (const i of g.instances) if (i.category !== 'unknown' || i.ports.length) by.set(i.category, [...(by.get(i.category) ?? []), i]);
  return CATEGORIES.filter((c) => by.has(c))
    .map((c) => {
      const list = by.get(c)!;
      const ports = [...new Set(list.map(mainPort).filter((p): p is number => p !== null))].sort((a, b) => a - b);
      const shown = ports.slice(0, 2).map((p) => ` :${p}`).join('');
      return `${list.length} ${CATEGORY_META[c].short}${shown}${ports.length > 2 ? ' …' : ''}`;
    })
    .join(' · ');
}

export const hasDuplicate = (g: GroupSummary): boolean => g.instances.some((i) => i.duplicate);

/** Ce que les étiquettes affichent, pour les comparateurs de rendu (RAM et CPU des instances n'y entrent pas). */
export function categoryDisplayKey(g: GroupSummary): string {
  let s = g.categories.join(',');
  for (const i of g.instances) s += `|${i.category}:${i.ports.join(',')}:${i.duplicate ? 1 : 0}`;
  return s;
}

/** Sélection mémorisée (`pw.categories`) : seules les catégories connues sont gardées. */
export function parseSelection(raw: string | null): Set<Category> {
  try {
    const v: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(v) ? v.filter(isCategory) : []);
  } catch {
    return new Set();
  }
}
