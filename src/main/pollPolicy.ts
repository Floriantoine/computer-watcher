/** Rythme de collecte en direct, fenêtre active. */
export const POLL_MS = 2000;
/** Fenêtre visible mais sans focus depuis plus de BLUR_GRACE_MS : on rafraîchit moins souvent. */
export const BACKGROUND_POLL_MS = 10_000;
export const BLUR_GRACE_MS = 60_000;

export interface WindowActivity {
  /** Réduite (événement minimize) ou cachée (hide) */
  hidden: boolean;
  /** Instant de la perte du focus, null si la fenêtre a le focus */
  blurredAt: number | null;
}

/**
 * Délai avant la prochaine collecte, null = pas de collecte.
 * Sous Wayland (KWin, GNOME) une réduction faite par le compositeur n'envoie ni `minimize` ni `hide` :
 * seule la perte de focus est visible, d'où le rythme de fond après une minute sans focus.
 */
export function pollDelay(w: WindowActivity, now: number): number | null {
  if (w.hidden) return null;
  if (w.blurredAt !== null && now - w.blurredAt >= BLUR_GRACE_MS) return BACKGROUND_POLL_MS;
  return POLL_MS;
}
