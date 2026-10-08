// Prévision d'épuisement de la mémoire (②) : pur, sans import Node (service d'enregistrement, tests).
//
// Marge = max(mémoire disponible − seuil mémoire, swap libre − seuil swap) : earlyoom n'agit que lorsque les DEUX sont
// sous leur seuil. Sans swap, la marge mémoire seule. Pente par moindres carrés sur les 5 dernières minutes.
// Contre les fausses alertes sur un pic court (un vitest qui prend 3 Go en 40 s puis les rend), l'alerte exige en plus
// une marge en baisse sur au moins 3 des 5 dernières minutes (moyennes par minute).
import type { EarlyoomThresholds } from './earlyoom';

export interface MarginSample { ts: number; memAvailableKB: number; swapFreeKB: number; memTotalKB: number; swapTotalKB: number }
export interface Forecast {
  /** Marge au dernier échantillon (Ko). */
  marginKB: number;
  slopeKBPerMin: number;
  /** Minutes avant que la marge atteigne 0 ; null si elle ne baisse pas. */
  etaMin: number | null;
  /** Comparaisons successives (sur 5) où la moyenne d'une minute baisse par rapport à la précédente. */
  decliningMinutes: number;
  spanMin: number;
}

const MIN = 60_000;
export const WINDOW_MS = 5 * MIN;
export const ALERT_ETA_MIN = 10;
export const ALERT_EVERY_MS = 30 * MIN;
export const SNOOZE_MS = 30 * MIN;
export const MIN_DECLINING = 3;
const MIN_SAMPLES = 12;
const MIN_SPAN_MS = 4 * MIN;

/** Seuils en Ko pour cette machine (sans swap : seuil swap 0). */
export function thresholdKB(t: EarlyoomThresholds, s: { memTotalKB: number; swapTotalKB: number }): { memKB: number; swapKB: number } {
  return { memKB: (s.memTotalKB * t.memPercent) / 100, swapKB: (s.swapTotalKB * t.swapPercent) / 100 };
}

/** Échantillons des dernières `keepMs` (6 min : la minute avant la fenêtre sert au compte des minutes en baisse). */
export class MarginBuffer {
  private buf: MarginSample[] = [];
  constructor(private readonly keepMs = WINDOW_MS + MIN) {}
  push(s: MarginSample): void {
    // horloge revenue en arrière : on repart de zéro plutôt que de mélanger les instants
    if (this.buf.length && s.ts <= this.buf[this.buf.length - 1]!.ts) this.buf = [];
    this.buf.push(s);
    const cut = s.ts - this.keepMs;
    let i = 0;
    while (i < this.buf.length && this.buf[i]!.ts < cut) i++;
    if (i) this.buf.splice(0, i);
  }
  samples(): readonly MarginSample[] {
    return this.buf;
  }
}

export function marginKB(s: MarginSample, t: EarlyoomThresholds): number {
  const th = thresholdKB(t, s);
  const mem = s.memAvailableKB - th.memKB;
  return s.swapTotalKB > 0 ? Math.max(mem, s.swapFreeKB - th.swapKB) : mem;
}

export function forecast(samples: readonly MarginSample[], t: EarlyoomThresholds, now: number): Forecast | null {
  const win = samples.filter((s) => s.ts >= now - WINDOW_MS && s.ts <= now);
  if (win.length < MIN_SAMPLES) return null;
  const span = win[win.length - 1]!.ts - win[0]!.ts;
  if (span < MIN_SPAN_MS) return null;
  // moindres carrés, x en minutes depuis le premier échantillon
  const xs = win.map((s) => (s.ts - win[0]!.ts) / MIN);
  const ys = win.map((s) => marginKB(s, t));
  const n = win.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const margin = ys[n - 1]!;
  const etaMin = slope < 0 ? (margin <= 0 ? 0 : margin / -slope) : null;

  // 6 tranches d'une minute (la minute avant la fenêtre + 5) : moyenne de marge par tranche
  const sums = new Array<number>(6).fill(0);
  const counts = new Array<number>(6).fill(0);
  for (const s of samples) {
    const k = 5 - Math.floor((now - s.ts) / MIN);
    if (s.ts > now || k < 0 || k > 5) continue;
    sums[k] += marginKB(s, t);
    counts[k]++;
  }
  let declining = 0;
  for (let k = 1; k < 6; k++) {
    if (!counts[k] || !counts[k - 1]) continue;
    if (sums[k]! / counts[k]! < sums[k - 1]! / counts[k - 1]!) declining++;
  }
  return { marginKB: margin, slopeKBPerMin: slope, etaMin, decliningMinutes: declining, spanMin: span / MIN };
}

export interface AlertState { lastAlertAt: number | null; snoozedUntil: number | null }

export function shouldAlert(f: Forecast | null, s: AlertState, now: number): boolean {
  if (!f || f.etaMin === null || f.etaMin >= ALERT_ETA_MIN || f.decliningMinutes < MIN_DECLINING) return false;
  if (s.lastAlertAt !== null && now - s.lastAlertAt < ALERT_EVERY_MS && now >= s.lastAlertAt) return false;
  return s.snoozedUntil === null || now >= s.snoozedUntil;
}

const GO = 1024 * 1024;
/** 3 250 000 Ko → « 3,1 Go » ; sous 1 Go → « 820 Mo ». */
export function formatGo(kb: number): string {
  return kb >= GO ? `${(kb / GO).toFixed(1).replace('.', ',')} Go` : `${Math.round(kb / 1024)} Mo`;
}

/** Titre et corps de l'alerte : « Mémoire épuisée dans ~8 min », « Claude +3,1 Go en 5 min · swap 82 % ». */
export function alertText(f: Forecast, top: readonly { label: string; deltaKB: number }[], swapPct: number): { title: string; body: string } {
  const eta = f.etaMin ?? Infinity;
  const title = eta < 1 ? "Mémoire épuisée dans moins d'une minute" : `Mémoire épuisée dans ~${Math.round(eta)} min`;
  const parts = top.filter((g) => g.deltaKB > 0).slice(0, 2).map((g) => `${g.label} +${formatGo(g.deltaKB)} en 5 min`);
  parts.push(`swap ${Math.round(swapPct)} %`);
  return { title, body: parts.join(' · ') };
}
