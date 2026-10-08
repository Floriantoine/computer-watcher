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
 * Instances visées par « Tuer la sélection » : catégories sélectionnées, non protégées, dans un groupe qui contient des
 * processus de l'utilisateur (`killable`). Les pids réels et les garde-fous (uid, startTicks) restent côté main.
 */
export function killableInstances(groups: readonly GroupSummary[], selected: ReadonlySet<Category>): InstanceSummary[] {
  if (selected.size === 0) return [];
  const out: InstanceSummary[] = [];
  for (const g of groups) {
    if (g.kind === 'others' || !g.killable) continue;
    for (const i of g.instances) if (selected.has(i.category) && !i.protected) out.push(i);
  }
  return out;
}

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

/** Résumé d'une carte projet : « 1 front :5173 · 2 back :3000 :3001 » (au plus 2 ports par catégorie). */
export function instancesLine(g: GroupSummary): string {
  const by = new Map<Category, InstanceSummary[]>();
  for (const i of g.instances) by.set(i.category, [...(by.get(i.category) ?? []), i]);
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
