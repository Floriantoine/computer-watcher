import { useEffect, useState, type CSSProperties } from 'react';
import { BellRing, FolderOpen, Gauge, Skull, TrendingUp, type LucideIcon } from 'lucide-react';
import type { AlertType } from '../../../core/alerts';
import type { Config } from '../../../core/types';
import { CHANNEL_LABELS, parseIntervalInput, SETTINGS_ALERT_TYPES, withChannel, withInterval } from '../alertsSettings';
import { eventMarkers } from '../metrics';
import '../alerts.css';

const ICONS: Partial<Record<AlertType, LucideIcon>> = { earlyoom_kill: Skull, leak: TrendingUp, tmpfs: FolderOpen, pressure: Gauge };
const colorOf = (type: AlertType) => eventMarkers([{ ts: 0, type, groupKey: null, groupLabel: null, detail: {} }])[0]!.color;

/** Réglages › Alertes : canal par type (pop-up et bureau / pop-up seulement / rien), anti-spam du bureau. */
export function AlertsSettings({ config, onSave }: { config: Config; onSave: (c: Config) => void }) {
  const [interval, setIntervalText] = useState(String(config.alerts.desktopMinIntervalMin));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setIntervalText(String(config.alerts.desktopMinIntervalMin)), [config.alerts.desktopMinIntervalMin]);
  const saveInterval = () => {
    const r = parseIntervalInput(interval);
    if ('error' in r) return setError(r.error);
    setError(null);
    if (r.value !== config.alerts.desktopMinIntervalMin) onSave(withInterval(config, r.value));
  };
  return (
    <section data-testid="alerts-panel">
      <h3><BellRing size={15} strokeWidth={2} />Alertes</h3>
      <p className="hint">
        Pop-up en haut à droite de proc-watch, qui reste jusqu'à ce que tu le fermes. Notification du bureau envoyée par le service
        d'enregistrement, même app fermée (rien quand proc-watch est au premier plan) ; son bouton « Ouvrir » affiche l'alerte.
      </p>
      <ul className="alert-channels">
        {SETTINGS_ALERT_TYPES.map(({ type, label }) => {
          const Icon = ICONS[type] ?? BellRing;
          const current = config.alerts.channels[type];
          return (
            <li key={type} data-testid={`alert-channel-${type}`}>
              <span className="alert-type" style={{ '--alert': colorOf(type) } as CSSProperties}>
                <Icon size={14} strokeWidth={2.2} />
                {label}
              </span>
              <div className="range-selector" role="radiogroup" aria-label={`Canal : ${label}`}>
                {CHANNEL_LABELS.map(([ch, chLabel]) => (
                  <button
                    key={ch}
                    type="button"
                    role="radio"
                    aria-checked={current === ch}
                    data-testid={`alert-channel-${type}-${ch}`}
                    className={current === ch ? 'active' : ''}
                    onClick={() => current !== ch && onSave(withChannel(config, type, ch))}
                  >
                    {current === ch && <span className="range-indicator" />}
                    <span>{chLabel}</span>
                  </button>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="row alert-interval">
        <label>
          Au plus une notification du bureau par type toutes les
          <input
            type="number"
            min="1"
            max="120"
            value={interval}
            aria-label="Intervalle entre deux notifications du bureau d'un même type"
            aria-invalid={!!error}
            data-testid="alert-interval"
            onChange={(e) => setIntervalText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && saveInterval()}
            style={{ width: 70 }}
          />
          min
        </label>
        <button onClick={saveInterval}>Enregistrer</button>
      </div>
      {error && <span className="field-error">{error}</span>}
      <p className="hint">Notifications du bureau : <code>notify-send</code> requis (paquet libnotify) ; sans lui, seulement les pop-ups.</p>
    </section>
  );
}
