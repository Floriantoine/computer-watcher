import { Fragment, useMemo, useState } from 'react';
import { BellRing, FolderOpen, Gauge, Settings2, Skull, TrendingUp, Unplug, type LucideIcon } from 'lucide-react';
import type { HistoryEvent } from '../../../core/types';
import { alertsFrom, eventMarkers, formatInstant } from '../metrics';
import { TmpDirsList } from './TmpDirsList';

const ICONS: Record<string, LucideIcon> = { leak: TrendingUp, earlyoom_kill: Skull, pressure: Gauge, gap: Unplug, tmpfs: FolderOpen };

interface Props {
  events: HistoryEvent[] | undefined;
  onPick: (ts: number) => void;
  /** Survol d'une alerte : met en avant son marqueur dans les graphes (null en sortie). */
  onHover?: (ts: number | null) => void;
  /** Ouvre Réglages › Alertes. */
  onSettings?: () => void;
}

/**
 * Fuites, kills earlyoom, pics de pression, fichiers en mémoire et trous d'enregistrement ; un clic place le curseur de l'enquête.
 * Une alerte « fichiers en mémoire » déplie les plus gros dossiers actuels de /tmp.
 */
export function AlertsPanel({ events, onPick, onHover, onSettings }: Props) {
  const alerts = useMemo(() => eventMarkers(alertsFrom(events ?? [])), [events]);
  const [tmpOpen, setTmpOpen] = useState<number | null>(null);
  return (
    <section className="chart-panel metrics-list" data-testid="alerts">
      <div className="chart-panel-head">
        <h3><BellRing size={14} strokeWidth={2} /> Alertes</h3>
        {alerts.length > 0 && <span className="count">{alerts.length}</span>}
        {onSettings && (
          <button className="icon-btn sm alerts-settings-link" title="Régler les alertes" aria-label="Régler les alertes" data-testid="alerts-settings-link" onClick={onSettings}>
            <Settings2 size={13} strokeWidth={2} />
          </button>
        )}
      </div>
      {!alerts.length ? (
        <div className="chart-empty small">{events === undefined ? 'Chargement…' : 'Aucune alerte sur la plage'}</div>
      ) : (
        <ul onMouseLeave={() => onHover?.(null)}>
          {alerts.map((a, i) => {
            const Icon = ICONS[a.type] ?? BellRing;
            const open = a.type === 'tmpfs' && tmpOpen === a.ts;
            return (
              <Fragment key={`${a.ts}-${i}`}>
                <li className="clickable" title="Voir les coupables à cet instant" onClick={() => onPick(a.ts)} onMouseEnter={() => onHover?.(a.ts)}>
                  <span className="alert-ico" style={{ color: a.color, background: `${a.color}1f` }}>
                    <Icon size={13} strokeWidth={2.2} />
                  </span>
                  <span className="name" title={a.label}>{a.label}</span>
                  {a.type === 'tmpfs' && (
                    <button
                      className={`tmpfs-toggle${open ? ' on' : ''}`}
                      data-testid="tmpfs-toggle"
                      aria-expanded={open}
                      title="Plus gros dossiers de /tmp maintenant (pas à l’instant de l’alerte)"
                      onClick={(e) => {
                        e.stopPropagation();
                        setTmpOpen(open ? null : a.ts);
                      }}
                    >
                      Voir /tmp
                    </button>
                  )}
                  <span className="mono">{formatInstant(a.ts)}</span>
                </li>
                {open && (
                  <li className="tmp-dirs-row">
                    <TmpDirsList />
                  </li>
                )}
              </Fragment>
            );
          })}
        </ul>
      )}
    </section>
  );
}
