// src/core/alerts.ts — canaux des alertes (pop-up dans l'app, notification du bureau), textes, anti-spam. Pur, sans import Node.

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
}

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
};

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
  return { channels, desktopMinIntervalMin: interval, seenUpTo: seen };
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
      return { title: `Règle « ${str(d.rule)} » : ${str(d.target)}`, body: `Action ${str(d.result)}.` };
    case 'rule_dry_run':
      return { title: `Simulation « ${str(d.rule)} » : ${str(d.target)}`, body: 'Aucun processus touché (simulation).' };
  }
}
