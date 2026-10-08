import { AnimatePresence } from 'motion/react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import type { Category, GroupSummary as Group, InstanceSummary } from '../../../core/types';
import { countByCategory, filterGroups, killCount, parseSelection, selectionCandidates, showProjectsOnlyHint } from '../categoryFilter';
import { CategoryFilter } from './CategoryFilter';
import type { SortKey, ViewFilter } from '../viewModel';
import { findGroup, visibleGroups } from '../viewModel';
import { GroupCard, type GroupActions } from './GroupCard';
import { GroupList } from './GroupList';
import { ViewToggle, loadView, type ViewMode } from './ViewToggle';

interface Props {
  groups: Group[];
  /** Ids retenus par la recherche (calculée côté main), null sans recherche. */
  matches: Set<string> | null;
  memTotalKB: number;
  filter: ViewFilter;
  onFilter: (f: ViewFilter) => void;
  stuckPids: Set<number>;
  pendingPids: Set<number>;
  onOpen: (g: Group) => void;
  onKillGroup: (g: Group) => void;
  onForce: (pids: number[]) => void;
  sparkOf: (groupId: string) => (number | null)[];
  /** Groupes en fuite -> horodatage du dernier événement (Map stable, renouvelée au plus toutes les 60 s). */
  leakAt?: Map<string, number>;
  onLeak?: (ts: number) => void;
  /**
   * Dialogue de kill groupé (BulkKillDialog) ; absent → bouton « Tuer la sélection » désactivé. Reçoit toutes les instances candidates
   * (groupes projet / dossier supprimé des catégories choisies), protégées comprises avec leur drapeau : le dialogue les décoche.
   */
  onKillInstances?: (instances: InstanceSummary[]) => void;
  /** Carte / ligne « Autres » dépliée (aperçu de ses plus gros sous-groupes). */
  othersOpen: boolean;
  onToggleOthers: (open: boolean) => void;
}

const CATEGORIES_KEY = 'pw.categories';

function loadCategories(): Set<Category> {
  try {
    return parseSelection(localStorage.getItem(CATEGORIES_KEY));
  } catch {
    return new Set();
  }
}

function saveCategories(sel: Set<Category>): void {
  try {
    localStorage.setItem(CATEGORIES_KEY, JSON.stringify([...sel]));
  } catch {
    /* stockage indisponible : le filtre reste valable pour la session */
  }
}

const AGES: [string, number][] = [['Tous', 0], ['> 1 h', 3600], ['> 1 j', 86400], ['> 7 j', 7 * 86400]];

export function MainView(props: Props) {
  const { groups, matches, memTotalKB, filter, onFilter, stuckPids, pendingPids, sparkOf, leakAt, othersOpen } = props;
  const [view, setView] = useState<ViewMode>(loadView);
  const [categories, setCategories] = useState<Set<Category>>(loadCategories);
  const pickCategories = useCallback((next: Set<Category>) => {
    saveCategories(next);
    setCategories(next);
  }, []);
  const counts = useMemo(() => countByCategory(groups), [groups]);
  const candidates = useMemo(() => selectionCandidates(groups, categories), [groups, categories]);
  const filtered = useMemo(() => filterGroups(groups, categories), [groups, categories]);
  // Actions stables (par id, résolues sur les dernières props) : une carte inchangée n'a pas à se re-rendre.
  const latest = useRef(props);
  latest.current = props;
  const actions = useMemo<GroupActions>(() => {
    const find = (id: string) => latest.current.groups.find((g) => g.id === id);
    return {
      // Sous-groupes de « Autres » compris (aperçu de la carte dépliée).
      open: (id) => {
        const g = findGroup(latest.current.groups, id);
        if (g) latest.current.onOpen(g);
      },
      kill: (id) => {
        const g = find(id);
        if (g) latest.current.onKillGroup(g);
      },
      force: (id) => {
        const g = find(id);
        if (g) latest.current.onForce(g.pids.filter((pid) => latest.current.stuckPids.has(pid)));
      },
      leak: (id) => {
        const ts = latest.current.leakAt?.get(id);
        if (ts !== undefined) latest.current.onLeak?.(ts);
      },
      toggleOthers: (open) => latest.current.onToggleOthers(open),
    };
  }, []);
  const categoriesRef = useRef(categories);
  categoriesRef.current = categories;
  // Recalculé au clic sur le dernier snapshot, pas sur celui du rendu.
  const killSelection = useCallback(() => latest.current.onKillInstances?.(selectionCandidates(latest.current.groups, categoriesRef.current)), []);
  // Ordre affiché au rendu précédent (même tri) : tri mémoire/CPU avec tolérance, les cartes ne permutent pas sans cesse.
  const order = useRef<{ sort: SortKey; ids: string[] }>({ sort: filter.sort, ids: [] });
  const shown = visibleGroups(filtered, filter, matches, order.current.sort === filter.sort ? order.current.ids : []);
  useLayoutEffect(() => {
    order.current = { sort: filter.sort, ids: shown.map((g) => g.id) };
  });
  const layoutKey = shown.map((g) => g.id).join('\n');
  return (
    <>
      <div className="toolbar">
        <div className="search">
          <Search size={15} strokeWidth={2} />
          <input placeholder="Rechercher (nom, commande, dossier)…" value={filter.query} onChange={(e) => onFilter({ ...filter, query: e.target.value })} />
        </div>
        <label className="chip-select">
          <select aria-label="Tri" value={filter.sort} onChange={(e) => onFilter({ ...filter, sort: e.target.value as SortKey })}>
            <option value="mem">Tri : mémoire</option>
            <option value="cpu">Tri : CPU</option>
            <option value="age">Tri : ancienneté</option>
            <option value="name">Tri : nom</option>
          </select>
          <ChevronDown size={14} />
        </label>
        <label className="chip-select">
          <select aria-label="Âge minimum" value={filter.minAgeSec} onChange={(e) => onFilter({ ...filter, minAgeSec: Number(e.target.value) })}>
            {AGES.map(([label, sec]) => <option key={sec} value={sec}>{label}</option>)}
          </select>
          <ChevronDown size={14} />
        </label>
        <ViewToggle value={view} onChange={setView} />
      </div>
      <CategoryFilter
        counts={counts}
        selected={categories}
        onChange={pickCategories}
        killCount={killCount(candidates)}
        projectsOnlyHint={showProjectsOnlyHint(categories, candidates)}
        onKillSelection={props.onKillInstances ? killSelection : undefined}
      />
      {shown.length === 0 ? (
        <p className="empty">Aucun groupe ne correspond.</p>
      ) : view === 'list' ? (
        <GroupList groups={shown} sparkOf={sparkOf} stuckPids={stuckPids} pendingPids={pendingPids} actions={actions} leakAt={leakAt} othersOpen={othersOpen} />
      ) : (
        <div className="cards">
          <AnimatePresence mode="popLayout" initial={false}>
            {shown.map((g) => (
              <GroupCard
                key={g.id}
                group={g}
                memTotalKB={memTotalKB}
                spark={sparkOf(g.id)}
                stuck={g.pids.some((pid) => stuckPids.has(pid))}
                pending={g.pids.some((pid) => pendingPids.has(pid))}
                leak={leakAt?.has(g.id)}
                layoutKey={layoutKey}
                actions={actions}
                othersOpen={g.kind === 'others' && othersOpen}
              />
            ))}
          </AnimatePresence>
        </div>
      )}
    </>
  );
}
