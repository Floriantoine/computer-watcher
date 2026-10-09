// src/core/alerts.ts — canaux des alertes (pop-up dans l'app, notification du bureau), textes, anti-spam. Pur, sans import Node.

import { APP_DISPLAY_NAME } from './appName';

/** Types d'événements qui sont des alertes (les autres — gap, app_kill — n'en sont pas). */
export const ALERT_TYPES = ['earlyoom_kill', 'leak', 'tmpfs', 'pressure', 'forecast', 'rule_action', 'rule_dry_run'] as const;
export type AlertType = (typeof ALERT_TYPES)[number];
export type AlertChannel = 'both' | 'popup' | 'none';
export const ALERT_CHANNELS: readonly AlertChannel[] = ['both', 'popup', 'none'];

export interface AlertsConfig {
  channels: Record<AlertType, AlertChannel>;
  /** Au plus une notification du bureau par type toutes les `desktopMinIntervalMin` minutes. */
  desktopMinIntervalMin: number;
  /** Alertes vues (pop-ups fermés) jusqu'à cet horodatage inclus ; 0 = jamais initialisé (le main le met à « maintenant »). */
  seenUpTo: number;
  /** Ids des alertes fermées postérieures à seenUpTo (fermées dans le désordre), au plus MAX_SEEN_IDS. */
  seenIds: number[];
}

export const MAX_SEEN_IDS = 200;

export const DESKTOP_INTERVAL_BOUNDS = { min: 1, max: 120 } as const;

export const DEFAULT_ALERTS: AlertsConfig = {
  channels: {
    earlyoom_kill: 'both',
    leak: 'both',
    tmpfs: 'both',
    pressure: 'popup',
    forecast: 'both',
    rule_action: 'both',
    rule_dry_run: 'popup',
  },
  desktopMinIntervalMin: 5,
  seenUpTo: 0,
  seenIds: [],
};

export const isAlertId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
export const isAlertType = (t: unknown): t is AlertType => typeof t === 'string' && (ALERT_TYPES as readonly string[]).includes(t);
const isChannel = (c: unknown): c is AlertChannel => typeof c === 'string' && (ALERT_CHANNELS as readonly string[]).includes(c);

/** Absent → défauts ; champs absents → défauts ; types de canaux inconnus ignorés (config d'une autre version). */
export function validateAlerts(raw: unknown): AlertsConfig | null {
  if (raw === undefined) return structuredClone(DEFAULT_ALERTS);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const channels = { ...DEFAULT_ALERTS.channels };
  if (r.channels !== undefined) {
    if (typeof r.channels !== 'object' || r.channels === null || Array.isArray(r.channels)) return null;
    for (const [k, v] of Object.entries(r.channels)) {
      if (!isAlertType(k)) continue;
      if (!isChannel(v)) return null;
      channels[k] = v;
    }
  }
  const interval = r.desktopMinIntervalMin ?? DEFAULT_ALERTS.desktopMinIntervalMin;
  if (typeof interval !== 'number' || !Number.isInteger(interval) || interval < DESKTOP_INTERVAL_BOUNDS.min || interval > DESKTOP_INTERVAL_BOUNDS.max) return null;
  const seen = r.seenUpTo ?? 0;
  if (typeof seen !== 'number' || !Number.isFinite(seen) || seen < 0) return null;
  const ids = r.seenIds ?? [];
  if (!Array.isArray(ids) || ids.length > MAX_SEEN_IDS || !ids.every(isAlertId)) return null;
  return { channels, desktopMinIntervalMin: interval, seenUpTo: seen, seenIds: [...ids] };
}

/** Alerte telle que lue dans la table `events` (id = rowid, sert à `--alert=<id>`). */
export interface AlertEvent {
  id: number;
  ts: number;
  type: AlertType;
  groupKey: string | null;
  groupLabel: string | null;
  detail: Record<string, unknown>;
}

export function desktopAllowed(lastByType: ReadonlyMap<string, number>, type: AlertType, now: number, intervalMin: number): boolean {
  const last = lastByType.get(type);
  if (last === undefined || now < last) return true;
  return now - last >= intervalMin * 60_000;
}

/** Fichier d'état écrit par le main : la fenêtre a le focus (`focused`) à l'instant `ts`. */
export interface FocusState { focused: boolean; ts: number }
export const FOCUS_FRESH_MS = 10_000;
/** Le main réécrit l'état toutes les `FOCUS_REFRESH_MS` tant que la fenêtre a le focus. */
export const FOCUS_REFRESH_MS = 4_000;

export function appFocused(s: FocusState | null, now: number): boolean {
  if (!s || !s.focused || !Number.isFinite(s.ts)) return false;
  return s.ts <= now && now - s.ts < FOCUS_FRESH_MS;
}

export function parseFocusState(text: string): FocusState | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    return typeof o.focused === 'boolean' && typeof o.ts === 'number' ? { focused: o.focused, ts: o.ts } : null;
  } catch {
    return null;
  }
}

export const ALERT_FLAG = '--alert=';

/** Id d'alerte passé à l'app (`--alert=<id>`, entier positif) ; le dernier gagne. */
export function alertIdFromArgv(argv: readonly string[]): number | null {
  let id: number | null = null;
  for (const a of argv) {
    if (!a.startsWith(ALERT_FLAG)) continue;
    const v = a.slice(ALERT_FLAG.length);
    id = /^\d{1,15}$/.test(v) && Number(v) > 0 ? Number(v) : null;
  }
  return id;
}

function fmtKB(kb: number): string {
  if (!Number.isFinite(kb)) return '?';
  if (kb >= 1024 * 1024) return `${(kb / (1024 * 1024)).toFixed(1).replace('.', ',')} Go`;
  if (kb >= 1024) return `${Math.round(kb / 1024)} Mo`;
  return `${Math.round(kb)} Ko`;
}

/** Titre et corps d'une alerte : les mêmes pour le pop-up et la notification du bureau. */
export function alertMessage(e: AlertEvent): { title: string; body: string } {
  const d = e.detail;
  const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '?');
  switch (e.type) {
    case 'earlyoom_kill':
      return { title: `earlyoom a arrêté ${str(d.name)}`, body: `Mémoire épuisée : ${str(d.signal)} envoyé au processus ${str(d.pid)}.` };
    case 'leak':
      return {
        title: `Fuite probable : ${e.groupLabel ?? e.groupKey ?? '?'}`,
        body: `+${fmtKB(Number(d.growthKB))} en ${str(d.minutes)} min (${fmtKB(Number(d.memKB))} au total).`,
      };
    case 'tmpfs':
      return {
        title: `Fichiers en mémoire : ${fmtKB(Number(d.shmemKB))}`,
        body: `Au-dessus du seuil de ${fmtKB(Number(d.thresholdKB))} (/tmp, mémoire partagée).`,
      };
    case 'pressure':
      return { title: `Pression mémoire ${Math.round(Number(d.psi))} %`, body: 'Le système attend la mémoire (PSI, 10 dernières secondes).' };
    case 'forecast': {
      const eta = Number(d.etaMin);
      const title = !Number.isFinite(eta) ? 'Mémoire bientôt épuisée' : eta < 1 ? "Mémoire épuisée dans moins d'une minute" : `Mémoire épuisée dans ~${Math.round(eta)} min`;
      return { title, body: typeof d.body === 'string' ? d.body : '' };
    }
    case 'rule_action':
    case 'rule_dry_run':
      return ruleEventText(e.type, d);
  }
}

/**
 * Textes des événements de règles (⑥), partagés par le pop-up, la notification du bureau et la liste « Alertes » :
 * « Règle « vitest > 4 Go » : vitest arrêté (4,3 Go) », « Simulation « … » : aurait arrêté vitest (4,3 Go) »,
 * « Règle « … » : quota atteint ».
 */
export function ruleEventText(type: 'rule_action' | 'rule_dry_run', d: Record<string, unknown>): { title: string; body: string } {
  const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '?');
  const rule = `« ${str(d.rule)} »`;
  const target = str(d.target);
  const mem = Number.isFinite(Number(d.memKB)) && d.memKB !== undefined ? ` (${fmtKB(Number(d.memKB))})` : '';
  const pause = 'Au plus 10 actions par heure : la règle est en pause pendant 1 h.';
  if (type === 'rule_dry_run') {
    if (d.result === 'quota') return { title: `Simulation ${rule} : quota atteint`, body: pause };
    return { title: `Simulation ${rule} : aurait arrêté ${target}${mem}`, body: 'Aucun processus touché (simulation).' };
  }
  switch (d.result) {
    case 'sigterm':
      return { title: `Règle ${rule} : ${target} arrêté${mem}`, body: `SIGTERM envoyé ; SIGKILL 5 s plus tard s'il est toujours là.` };
    case 'sigkill':
      return { title: `Règle ${rule} : ${target} forcé (SIGKILL)`, body: 'Toujours vivant 5 s après SIGTERM.' };
    case 'refused':
      return { title: `Règle ${rule} : ${target} non arrêté`, body: 'Garde-fous : aucun signal envoyé.' };
    case 'quota':
      return { title: `Règle ${rule} : quota atteint`, body: pause };
    default:
      return { title: `Règle ${rule} : ${target}`, body: `Résultat : ${str(d.result)}.` };
  }
}

/** Titres des notifications du bureau : fixes par type (aucun nom de processus ou de groupe, interprétés en balisage par certains démons). */
export const DESKTOP_TITLES: Record<AlertType, string> = {
  earlyoom_kill: 'Kill earlyoom',
  leak: 'Fuite probable',
  tmpfs: 'Fichiers en mémoire',
  pressure: 'Pression mémoire',
  forecast: 'Mémoire bientôt épuisée',
  rule_action: 'Règle exécutée',
  rule_dry_run: 'Règle simulée',
};
/** Longueur maximale du corps (caractères, avant échappement). */
export const DESKTOP_BODY_MAX = 300;

/** Retire les caractères de contrôle et de direction (sauts de ligne, tabulations → espace). */
export function desktopText(s: string): string {
  return s
    .replace(/[\t\n\r\v\f\u0085\u2028\u2029]/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeMarkup = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);

/**
 * Texte d'une notification du bureau : titre fixe par type ; noms et libellés seulement dans le corps, nettoyés, coupés
 * à DESKTOP_BODY_MAX puis échappés (le corps est du balisage pour notify-send).
 */
export function desktopMessage(e: AlertEvent): { title: string; body: string } {
  const m = alertMessage(e);
  let text = desktopText([m.title, m.body].filter(Boolean).join(' — '));
  if (text.length > DESKTOP_BODY_MAX) text = `${text.slice(0, DESKTOP_BODY_MAX - 1)}…`;
  return { title: `${APP_DISPLAY_NAME} — ${DESKTOP_TITLES[e.type]}`, body: escapeMarkup(text) };
}
