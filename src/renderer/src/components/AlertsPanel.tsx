import { useMemo } from 'react';
import { BellRing, Gauge, Skull, TrendingUp, Unplug, type LucideIcon } from 'lucide-react';
import type { HistoryEvent } from '../../../core/types';
import { alertsFrom, eventMarkers } from '../metrics';
import { formatAxisTime } from './charts/uplotTheme';

const ICONS: Record<string, LucideIcon> = { leak: TrendingUp, earlyoom_kill: Skull, pressure: Gauge, gap: Unplug };
const DAY_MS = 86_400_000;

interface Props {
  events: HistoryEvent[] | undefined;
  onPick: (ts: number) => void;
}

/** Fuites, kills earlyoom, pics de pression et trous d'enregistrement ; un clic place le curseur de l'enquête. */
export function AlertsPanel({ events, onPick }: Props) {
  const alerts = useMemo(() => eventMarkers(alertsFrom(events ?? [])), [events]);
  const today = new Date().toDateString();
  return (
    <section className="chart-panel metrics-list" data-testid="alerts">
      <div className="chart-panel-head">
        <h3><BellRing size={14} strokeWidth={2} /> Alertes</h3>
        {alerts.length > 0 && <span className="count">{alerts.length}</span>}
      </div>
      {!alerts.length ? (
        <div className="chart-empty small">{events === undefined ? 'Chargement…' : 'Aucune alerte sur la plage'}</div>
      ) : (
        <ul>
          {alerts.map((a, i) => {
            const Icon = ICONS[a.type] ?? BellRing;
            const sameDay = new Date(a.ts).toDateString() === today;
            return (
              <li key={`${a.ts}-${i}`} className="clickable" title="Voir les coupables à cet instant" onClick={() => onPick(a.ts)}>
                <span className="alert-ico" style={{ color: a.color, background: `${a.color}1f` }}>
                  <Icon size={13} strokeWidth={2.2} />
                </span>
                <span className="name">{a.label}</span>
                <span className="mono">{formatAxisTime(a.ts, sameDay ? 0 : DAY_MS + 1)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
