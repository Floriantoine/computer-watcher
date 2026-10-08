import { useEffect, useState, type CSSProperties } from 'react';
import { BellRing, FolderOpen, Gauge, Hourglass, MonitorSmartphone, Skull, TrendingUp, type LucideIcon } from 'lucide-react';
import type { AlertType } from '../../../core/alerts';
import type { Config, RecorderState } from '../../../core/types';
import { CHANNEL_LABELS, forecastNote, parseIntervalInput, SETTINGS_ALERT_TYPES, withChannel, withInterval } from '../alertsSettings';
import { eventMarkers } from '../metrics';
import type { FormState } from '../settingsNav';
import { Card, NumberField, Row, SaveBar } from './settingsUi';
import '../alerts.css';

const ICONS: Partial<Record<AlertType, LucideIcon>> = { earlyoom_kill: Skull, leak: TrendingUp, tmpfs: FolderOpen, pressure: Gauge, forecast: Hourglass };
const colorOf = (type: AlertType) => eventMarkers([{ ts: 0, type, groupKey: null, groupLabel: null, detail: {} }])[0]!.color;

/** Réglages › Alertes : canal par type (pop-up et bureau / pop-up seulement / rien), anti-spam du bureau. */
export function AlertsSettings({ config, onSave, onFormState, recorder = null }: { config: Config; onSave: (c: Config) => void; onFormState?: (s: FormState) => void; recorder?: RecorderState | null }) {
  const fNote = forecastNote(recorder);
  const [interval, setIntervalText] = useState(String(config.alerts.desktopMinIntervalMin));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setIntervalText(String(config.alerts.desktopMinIntervalMin)), [config.alerts.desktopMinIntervalMin]);
  const parsed = parseIntervalInput(interval);
  const dirty = !('value' in parsed) || parsed.value !== config.alerts.desktopMinIntervalMin;
  const invalid = 'error' in parsed;
  useEffect(() => onFormState?.({ dirty, invalid }), [dirty, invalid, onFormState]);
  const saveInterval = () => {
    const r = parseIntervalInput(interval);
    if ('error' in r) return setError(r.error);
    setError(null);
    if (r.value !== config.alerts.desktopMinIntervalMin) onSave(withInterval(config, r.value));
  };
  return (
    <div className="s-stack" data-testid="alerts-panel">
      <Card title="Canal par type" icon={<BellRing size={14} strokeWidth={2} />}>
        <p className="hint">
          Pop-up en haut à droite de proc-watch, qui reste jusqu'à ce que tu le fermes. Notification du bureau envoyée par le service
          d'enregistrement, même app fermée (rien quand proc-watch est au premier plan) ; son bouton « Ouvrir » affiche l'alerte.
          Enregistré dès le choix.
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
                  {type === 'forecast' && fNote && (
                    <span className="alert-type-note" data-testid="forecast-note">{fNote}</span>
                  )}
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
      </Card>

      <Card title="Notifications du bureau" icon={<MonitorSmartphone size={14} strokeWidth={2} />}>
        <Row
          label="Intervalle minimal par type"
          error={error}
          help={<>Au plus une notification du bureau par type pendant cette durée. <code>notify-send</code> requis (paquet libnotify) ; sans lui, seulement les pop-ups.</>}
        >
          {(id) => (
            <NumberField
              id={id}
              min="1"
              max={120}
              value={interval}
              unit="min"
              ariaLabel="Intervalle entre deux notifications du bureau d'un même type"
              invalid={!!error}
              testid="alert-interval"
              onChange={setIntervalText}
              onEnter={saveInterval}
            />
          )}
        </Row>
        <SaveBar dirty={dirty} onSave={saveInterval} testid="alerts-save" />
      </Card>
    </div>
  );
}
