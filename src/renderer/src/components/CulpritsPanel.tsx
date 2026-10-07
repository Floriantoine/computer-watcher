import { ChevronRight, X } from 'lucide-react';
import type { Culprit } from '../../../core/types';
import { formatKB } from '../format';
import { formatInstant } from '../metrics';
import { GroupIcon } from './ui';

interface Props {
  ts: number;
  culprits: Culprit[] | undefined;
  canOpen: (key: string) => boolean;
  onOpenGroup: (key: string) => void;
  onClose: () => void;
}


function delta(kb: number): string {
  if (kb > 0) return `+${formatKB(kb)}`;
  if (kb < 0) return `−${formatKB(-kb)}`;
  return '0';
}

/** Colonne « instant cliqué » : groupes triés par hausse de mémoire sur les 5 min avant l'instant choisi. */
export function CulpritsPanel({ ts, culprits, canOpen, onOpenGroup, onClose }: Props) {
  return (
    <div className="culprits" data-testid="culprits-panel">
      <div className="culprits-head">
        <div>
          <h3>À {formatInstant(ts)} <span className="sub">— hausse sur 5 min</span></h3>
        </div>
        <button className="icon-btn sm" title="Fermer" aria-label="Fermer" onClick={onClose}>
          <X size={14} strokeWidth={2} />
        </button>
      </div>
      {culprits === undefined ? (
        <div className="culprits-empty">Chargement…</div>
      ) : culprits.length === 0 ? (
        <div className="culprits-empty">Aucune donnée à cet instant</div>
      ) : (
        <ul className="culprits-list">
          {culprits.map((c) => {
            const open = canOpen(c.key);
            return (
              <li
                key={c.key}
                className={open ? 'clickable' : ''}
                title={open ? 'Voir le détail' : 'Groupe terminé'}
                onClick={open ? () => onOpenGroup(c.key) : undefined}
              >
                <GroupIcon id={c.key} kind={c.kind} size="sm" />
                <span className="name" title={c.label}>{c.label}</span>
                <span className={`delta${c.deltaKB > 0 ? ' up' : ''}`}>{delta(c.deltaKB)}</span>
                <span className="mono total">{formatKB(c.memKB)}</span>
                <ChevronRight size={14} strokeWidth={2} className={open ? '' : 'hidden'} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
