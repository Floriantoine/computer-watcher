import { Trophy } from 'lucide-react';
import type { TopConsumer } from '../../../core/types';
import { formatKB } from '../format';
import { Sparkline } from './charts/Sparkline';
import { GroupIcon } from './ui';

interface Props {
  top: TopConsumer[] | undefined;
  canOpen: (key: string) => boolean;
  onOpenGroup: (key: string) => void;
  /** Survol d'une ligne : met en avant la courbe du groupe dans l'enquête (null en sortie). */
  onHover?: (key: string | null) => void;
}

/** Plus gros consommateurs de mémoire (moyenne) sur la plage : mini-courbe, pic et moyenne. */
export function TopConsumers({ top, canOpen, onOpenGroup, onHover }: Props) {
  return (
    <section className="chart-panel metrics-list" data-testid="top-consumers">
      <div className="chart-panel-head">
        <h3><Trophy size={14} strokeWidth={2} /> Top consommateurs</h3>
        <span className="spacer" />
        <span className="list-cols"><span>Pic</span><span>Moyenne</span></span>
      </div>
      {!top?.length ? (
        <div className="chart-empty small">{top === undefined ? 'Chargement…' : 'Aucune donnée sur la plage'}</div>
      ) : (
        <ul onMouseLeave={() => onHover?.(null)}>
          {top.map((t) => {
            const open = canOpen(t.key);
            return (
              <li
                key={t.key}
                className={open ? 'clickable' : ''}
                title={open ? 'Voir le détail' : 'Groupe terminé'}
                onClick={open ? () => onOpenGroup(t.key) : undefined}
                onMouseEnter={() => onHover?.(t.key)}
              >
                <GroupIcon id={t.key} kind={t.kind} size="sm" />
                <span className="name" title={t.label}>{t.label}</span>
                <span className="row-spark"><Sparkline values={t.spark} tone="mem" height={22} /></span>
                <span className="num">{formatKB(t.maxKB)}</span>
                <span className="num muted">{formatKB(t.avgKB)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
