import { AnimatePresence } from 'motion/react';
import { useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import type { Group } from '../../../core/types';
import type { SortKey, ViewFilter } from '../viewModel';
import { visibleGroups } from '../viewModel';
import { GroupCard } from './GroupCard';
import { GroupList } from './GroupList';
import { ViewToggle, loadView, type ViewMode } from './ViewToggle';

interface Props {
  groups: Group[];
  memTotalKB: number;
  filter: ViewFilter;
  onFilter: (f: ViewFilter) => void;
  stuckPids: Set<number>;
  pendingPids: Set<number>;
  onOpen: (g: Group) => void;
  onKillGroup: (g: Group) => void;
  onForce: (pids: number[]) => void;
  sparkOf: (groupId: string) => (number | null)[];
}

const AGES: [string, number][] = [['Tous', 0], ['> 1 h', 3600], ['> 1 j', 86400], ['> 7 j', 7 * 86400]];

export function MainView({ groups, memTotalKB, filter, onFilter, stuckPids, pendingPids, onOpen, onKillGroup, onForce, sparkOf }: Props) {
  const [view, setView] = useState<ViewMode>(loadView);
  const shown = visibleGroups(groups, filter);
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
      {shown.length === 0 ? (
        <p className="empty">Aucun groupe ne correspond.</p>
      ) : view === 'list' ? (
        <GroupList groups={shown} sparkOf={sparkOf} stuckPids={stuckPids} pendingPids={pendingPids} onOpen={onOpen} onKill={onKillGroup} onForce={onForce} />
      ) : (
        <div className="cards">
          <AnimatePresence mode="popLayout" initial={false}>
            {shown.map((g) => {
              const stuck = g.pids.filter((pid) => stuckPids.has(pid));
              return (
                <GroupCard
                  key={g.id}
                  group={g}
                  memTotalKB={memTotalKB}
                  spark={sparkOf(g.id)}
                  stuck={stuck.length > 0}
                  pending={g.pids.some((pid) => pendingPids.has(pid))}
                  layoutKey={layoutKey}
                  onOpen={() => onOpen(g)}
                  onKill={() => onKillGroup(g)}
                  onForce={() => onForce(stuck)}
                />
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </>
  );
}
