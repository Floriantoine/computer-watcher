import type { Group } from '../../../core/types';
import type { SortKey, ViewFilter } from '../viewModel';
import { visibleGroups } from '../viewModel';
import { GroupCard } from './GroupCard';

interface Props {
  groups: Group[];
  memTotalKB: number;
  filter: ViewFilter;
  onFilter: (f: ViewFilter) => void;
  stuckPids: Set<number>;
  onOpen: (g: Group) => void;
  onKillGroup: (g: Group) => void;
  onForce: (pids: number[]) => void;
  onSettings: () => void;
}

const AGES: [string, number][] = [['Tous', 0], ['> 1 h', 3600], ['> 1 j', 86400], ['> 7 j', 7 * 86400]];

export function MainView({ groups, memTotalKB, filter, onFilter, stuckPids, onOpen, onKillGroup, onForce, onSettings }: Props) {
  const shown = visibleGroups(groups, filter);
  return (
    <>
      <div className="toolbar">
        <input placeholder="Rechercher (nom, commande, dossier)…" value={filter.query} onChange={(e) => onFilter({ ...filter, query: e.target.value })} />
        <select value={filter.sort} onChange={(e) => onFilter({ ...filter, sort: e.target.value as SortKey })}>
          <option value="mem">Tri : mémoire</option>
          <option value="cpu">Tri : CPU</option>
          <option value="age">Tri : ancienneté</option>
          <option value="name">Tri : nom</option>
        </select>
        <select value={filter.minAgeSec} onChange={(e) => onFilter({ ...filter, minAgeSec: Number(e.target.value) })}>
          {AGES.map(([label, sec]) => <option key={sec} value={sec}>{label}</option>)}
        </select>
        <span className="spacer" />
        <button onClick={onSettings}>⚙ Réglages</button>
      </div>
      {shown.length === 0 ? (
        <p className="empty">Aucun groupe ne correspond.</p>
      ) : (
        <div className="cards">
          {shown.map((g) => {
            const stuck = g.pids.filter((pid) => stuckPids.has(pid));
            return (
              <GroupCard
                key={g.id}
                group={g}
                memTotalKB={memTotalKB}
                stuck={stuck.length > 0}
                onOpen={() => onOpen(g)}
                onKill={() => onKillGroup(g)}
                onForce={() => onForce(stuck)}
              />
            );
          })}
        </div>
      )}
    </>
  );
}
