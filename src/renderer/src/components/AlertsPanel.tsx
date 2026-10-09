import { useMemo } from 'react';
import { BellRing, Bot, FlaskConical, FolderOpen, Gauge, HardDrive, Hourglass, Settings2, Skull, TrendingUp, Unplug, type LucideIcon } from 'lucide-react';
import type { HistoryEvent } from '../../../core/types';
import { alertsFrom, eventMarkers, formatInstant } from '../metrics';

const ICONS: Record<string, LucideIcon> = {
  leak: TrendingUp, earlyoom_kill: Skull, pressure: Gauge, gap: Unplug, tmpfs: FolderOpen, forecast: Hourglass, rule_action: Bot, rule_dry_run: FlaskConical, disk_low: HardDrive,
};

interface Props {
  events: HistoryEvent[] | undefined;
  onPick: (ts: number) => void;
  /** Survol d'une alerte : met en avant son marqueur dans les graphes (null en sortie). */
  onHover?: (ts: number | null) => void;
  /** Ouvre Réglages › Alertes. */
  onSettings?: () => void;
  /** « Voir /tmp » d'une alerte « fichiers en mémoire » : ouvre la page /tmp. */
  onOpenTmp?: () => void;
}

/**
 * Fuites, kills earlyoom, actions et simulations des règles automatiques, pics de pression, fichiers en mémoire et trous d'enregistrement ; un clic place le curseur de l'enquête.
 * Une alerte « fichiers en mémoire » mène à la page /tmp (éléments actuels, à cocher pour les supprimer).
 */
export function AlertsPanel({ events, onPick, onHover, onSettings, onOpenTmp }: Props) {
  const alerts = useMemo(() => eventMarkers(alertsFrom(events ?? [])), [events]);
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
            return (
              <li key={`${a.ts}-${i}`} className="clickable" title="Voir les coupables à cet instant" onClick={() => onPick(a.ts)} onMouseEnter={() => onHover?.(a.ts)}>
                <span className="alert-ico" style={{ color: a.color, background: `${a.color}1f` }}>
                  <Icon size={13} strokeWidth={2.2} />
                </span>
                <span className="name" title={a.label}>{a.label}</span>
                {a.type === 'tmpfs' && onOpenTmp && (
                  <button
                    className="tmpfs-toggle"
                    data-testid="tmpfs-toggle"
                    title="Ouvrir la page /tmp : éléments actuels (pas à l’instant de l’alerte), à cocher pour les supprimer"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenTmp();
                    }}
                  >
                    Voir /tmp
                  </button>
                )}
                <span className="mono">{formatInstant(a.ts)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
