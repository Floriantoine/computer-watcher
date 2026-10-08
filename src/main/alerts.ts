// src/main/alerts.ts — côté main des alertes : « vu jusqu'à », état de focus pour le service, ouverture sur `--alert=<id>`.
import { ALERT_TYPES, FOCUS_REFRESH_MS, isAlertId, MAX_SEEN_IDS, type AlertType } from '../core/alerts';
import type { Config } from '../core/types';

/** seenUpTo absent (0) → maintenant : au premier lancement, les alertes déjà enregistrées ne s'affichent pas en pop-up. */
export function initSeenUpTo(c: Config, now: number): Config | null {
  return c.alerts.seenUpTo === 0 ? { ...c, alerts: { ...c.alerts, seenUpTo: now } } : null;
}

/** Ce que le renderer demande à la fermeture : `upTo` (vues jusqu'à cet instant) et/ou `ids` (alertes fermées). */
export interface SeenRequest { upTo?: number; ids?: number[] }

function parseSeen(raw: unknown, now: number): SeenRequest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: SeenRequest = {};
  if (r.upTo !== undefined) {
    if (typeof r.upTo !== 'number' || !Number.isFinite(r.upTo) || r.upTo < 0 || r.upTo > now + 60_000) return null;
    out.upTo = r.upTo;
  }
  if (r.ids !== undefined) {
    if (!Array.isArray(r.ids) || r.ids.length > MAX_SEEN_IDS || !r.ids.every(isAlertId)) return null;
    out.ids = r.ids as number[];
  }
  return out;
}

/**
 * Pop-ups fermés : seenUpTo avance (jamais de recul) et les ids fermés au-delà sont retenus (ils ne reviennent pas après un
 * redémarrage). Ids élagués : couverts par seenUpTo ou disparus de la base (`tsOf` null : base illisible, tout est gardé) ;
 * au plus MAX_SEEN_IDS, les plus récents. null si rien ne change ou demande refusée.
 */
export function markSeen(c: Config, raw: unknown, now: number, tsOf: (ids: number[]) => Map<number, number> | null): Config | null {
  const req = parseSeen(raw, now);
  if (!req) return null;
  const seenUpTo = Math.max(c.alerts.seenUpTo, req.upTo ?? 0);
  const union = [...new Set([...c.alerts.seenIds, ...(req.ids ?? [])])];
  const times = tsOf(union);
  const seenIds = union.filter((id) => (times ? (times.get(id) ?? -Infinity) > seenUpTo : true)).slice(-MAX_SEEN_IDS);
  if (seenUpTo === c.alerts.seenUpTo && seenIds.length === c.alerts.seenIds.length && seenIds.every((id, i) => id === c.alerts.seenIds[i])) return null;
  return { ...c, alerts: { ...c.alerts, seenUpTo, seenIds } };
}

/** Filtre des alertes non vues : types avec pop-up, ids déjà fermés. */
export function unseenFilter(c: Config): { types: AlertType[]; exclude: number[] } {
  return { types: ALERT_TYPES.filter((t) => c.alerts.channels[t] !== 'none'), exclude: c.alerts.seenIds };
}

/** Une config venue des Réglages garde le seenUpTo le plus récent et les ids fermés du main (la copie du renderer peut dater). */
export function keepSeenUpTo(next: Config, current: Config): Config {
  const seenUpTo = Math.max(next.alerts.seenUpTo, current.alerts.seenUpTo);
  return { ...next, alerts: { ...next.alerts, seenUpTo, seenIds: current.alerts.seenIds } };
}

/**
 * Fichier d'état lu par le service : fenêtre focalisée → `{ focused: true, ts }` réécrit toutes les FOCUS_REFRESH_MS
 * (périmé après 10 s si l'app plante) ; perte du focus → `{ focused: false }` tout de suite.
 */
export function createFocusWriter(deps: { write: (json: string) => void; now?: () => number }) {
  const now = deps.now ?? Date.now;
  let timer: NodeJS.Timeout | null = null;
  const write = (focused: boolean) => {
    try {
      deps.write(JSON.stringify({ focused, ts: now() }));
    } catch {
      // dossier de données inaccessible : le service enverra la notification, sans gravité
    }
  };
  return {
    set(focused: boolean) {
      if (focused) {
        write(true);
        if (!timer) timer = setInterval(() => write(true), FOCUS_REFRESH_MS);
        timer.unref?.();
      } else {
        if (timer) clearInterval(timer);
        timer = null;
        write(false);
      }
    },
  };
}

/**
 * Envoi différé (microtâche) et protégé : au démarrage à froid, `open()` est appelé pendant l'évaluation du module main,
 * avant que la fenêtre existe (un envoi synchrone lisait `mainWin` dans sa zone morte : ReferenceError, main planté).
 */
export function deferSend(send: () => void): void {
  queueMicrotask(() => {
    try {
      send();
    } catch {
      // fenêtre pas encore là : la demande reste en attente (`take`)
    }
  });
}

/** `--alert=<id>` : envoyée au renderer, et gardée pour lui s'il n'écoutait pas encore (premier chargement). */
export function createAlertOpener(send: (id: number) => void) {
  let pending: number | null = null;
  return {
    open(id: number) {
      pending = id;
      deferSend(() => send(id));
    },
    take(): number | null {
      const id = pending;
      pending = null;
      return id;
    },
  };
}
