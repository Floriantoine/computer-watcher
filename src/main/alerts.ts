// src/main/alerts.ts — côté main des alertes : « vu jusqu'à », état de focus pour le service, ouverture sur `--alert=<id>`.
import { FOCUS_REFRESH_MS } from '../core/alerts';
import type { Config } from '../core/types';

/** seenUpTo absent (0) → maintenant : au premier lancement, les alertes déjà enregistrées ne s'affichent pas en pop-up. */
export function initSeenUpTo(c: Config, now: number): Config | null {
  return c.alerts.seenUpTo === 0 ? { ...c, alerts: { ...c.alerts, seenUpTo: now } } : null;
}

/** Pop-ups fermés jusqu'à `ts` : seenUpTo avance (jamais de recul) ; null si rien à changer ou valeur refusée. */
export function markSeen(c: Config, ts: unknown, now: number): Config | null {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < 0 || ts > now + 60_000) return null;
  if (ts <= c.alerts.seenUpTo) return null;
  return { ...c, alerts: { ...c.alerts, seenUpTo: ts } };
}

/** Une config venue des Réglages garde le seenUpTo le plus récent (la copie du renderer peut dater). */
export function keepSeenUpTo(next: Config, current: Config): Config {
  const seenUpTo = Math.max(next.alerts.seenUpTo, current.alerts.seenUpTo);
  return seenUpTo === next.alerts.seenUpTo ? next : { ...next, alerts: { ...next.alerts, seenUpTo } };
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

/** `--alert=<id>` : envoyée au renderer, et gardée pour lui s'il n'écoutait pas encore (premier chargement). */
export function createAlertOpener(send: (id: number) => void) {
  let pending: number | null = null;
  return {
    open(id: number) {
      pending = id;
      send(id);
    },
    take(): number | null {
      const id = pending;
      pending = null;
      return id;
    },
  };
}
