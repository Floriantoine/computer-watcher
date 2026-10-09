// Alerte « disque presque plein » (pur) : seuil, tenue de 60 s, réarmement avec marge.

export interface DiskStat { mount: string; sizeKB: number; availKB: number }

const GB_KB = 1024 * 1024;
/** Condition tenue 60 s avant l'événement. */
export const DISK_LOW_HOLD_MS = 60_000;
/** Réarmée quand le libre repasse au-dessus du seuil + 5 % de la taille. */
const REARM_SHARE = 0.05;
/** Au redémarrage du service, une alerte plus ancienne que 24 h ne retient plus l'alerte suivante. */
const RESTART_MEMORY_MS = 24 * 3600_000;

/** Seuil en Ko : max(percent % de la taille, gb Go), c'est-à-dire le premier atteint quand le libre baisse. */
export function diskThresholdKB(sizeKB: number, percent: number, gb: number): number {
  return Math.max((sizeKB * percent) / 100, gb * GB_KB);
}

/** `belowSince` : début de la période continue sous le seuil ; `lastTs` : dernier événement. */
export interface DiskAlertState { armed: boolean; belowSince: number | null; lastTs: number | null }

/** État au démarrage du service : désarmé si une alerte de moins de 24 h existe pour cette partition (pas de doublon). */
export function initialDiskAlertState(lastTs: number | null, now: number): DiskAlertState {
  return { armed: lastTs === null || now - lastTs >= RESTART_MEMORY_MS, belowSince: null, lastTs };
}

/** Un événement quand le libre reste sous le seuil 60 s et que l'alerte est armée ; désarmée ensuite jusqu'au réarmement. */
export function shouldRecordDiskLow(s: DiskStat, thresholdKB: number, st: DiskAlertState, now: number): { record: boolean; state: DiskAlertState } {
  if (s.availKB < thresholdKB) {
    const belowSince = st.belowSince ?? now;
    if (st.armed && now - belowSince >= DISK_LOW_HOLD_MS) return { record: true, state: { armed: false, belowSince, lastTs: now } };
    return { record: false, state: { ...st, belowSince } };
  }
  const rearm = s.availKB > thresholdKB + REARM_SHARE * s.sizeKB;
  return { record: false, state: { ...st, armed: st.armed || rearm, belowSince: null } };
}
