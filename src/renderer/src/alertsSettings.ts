// Réglages › Alertes (logique pure) : canal par type, intervalle anti-spam des notifications du bureau.
import { DESKTOP_INTERVAL_BOUNDS, type AlertChannel, type AlertType } from '../../core/alerts';
import type { Config, RecorderState } from '../../core/types';

/** Types réglables (règles ⑥ comprises). */
export const SETTINGS_ALERT_TYPES: { type: AlertType; label: string }[] = [
  { type: 'earlyoom_kill', label: 'Kill earlyoom' },
  { type: 'leak', label: 'Fuite probable' },
  { type: 'tmpfs', label: 'Fichiers en mémoire (/tmp)' },
  { type: 'pressure', label: 'Pression mémoire' },
  { type: 'forecast', label: 'Mémoire bientôt épuisée (prévision)' },
  { type: 'rule_action', label: 'Règle automatique exécutée' },
  { type: 'rule_dry_run', label: 'Règle en simulation' },
  { type: 'disk_low', label: 'Disque presque plein' },
];

/** État de la prévision ② affiché à côté de sa ligne ; null quand elle fonctionne (ou état inconnu). */
export function forecastNote(rec: RecorderState | null): string | null {
  if (!rec) return null;
  if (!rec.running) return "Prévision indisponible : service d'enregistrement arrêté";
  const f = rec.status?.forecast;
  if (f === 'unavailable') return 'Prévision indisponible : moins de 5 mesures sur les 5 dernières minutes';
  if (f === 'warming') return 'Prévision en préparation (5 min de mesures)';
  return null;
}

export const CHANNEL_LABELS: [AlertChannel, string][] = [['both', 'Pop-up et bureau'], ['popup', 'Pop-up seulement'], ['none', 'Rien']];

export function withChannel(c: Config, type: AlertType, channel: AlertChannel): Config {
  return { ...c, alerts: { ...c.alerts, channels: { ...c.alerts.channels, [type]: channel } } };
}

export function withInterval(c: Config, min: number): Config {
  return { ...c, alerts: { ...c.alerts, desktopMinIntervalMin: min } };
}

export function parseIntervalInput(raw: string): { value: number } | { error: string } {
  const t = raw.trim();
  if (!t) return { error: 'Valeur requise' };
  const n = Number(t);
  const { min, max } = DESKTOP_INTERVAL_BOUNDS;
  return Number.isInteger(n) && n >= min && n <= max ? { value: n } : { error: `Un entier entre ${min} et ${max} est attendu` };
}
