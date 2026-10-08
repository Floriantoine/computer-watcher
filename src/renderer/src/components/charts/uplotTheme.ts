import type uPlot from 'uplot';
import type { SparkTone } from './Sparkline';
import { formatKB } from '../../format';

/* Valeurs reprises des tokens de styles.css (le canvas ne lit pas les variables CSS). */
export const AXIS_FONT = '11px Inter, system-ui, sans-serif';
export const AXIS_COLOR = '#8b91a0';
export const GRID_COLOR = 'rgba(255,255,255,.06)';
export const CURSOR_BG = '#15161c';

/** Teinte d'une série : jeu nommé du thème ou couleur brute `#rrggbb`. */
export type ChartTone = SparkTone | `#${string}`;

const TONES: Record<SparkTone, { fill: string; line: string }> = {
  mem: { fill: '#7c5cff', line: '#b56bff' },
  swap: { fill: '#ff5c8a', line: '#ff8a3d' },
  psi: { fill: '#22d3a6', line: '#3dd6ff' },
  cpu: { fill: '#9aa0ad', line: '#c9cdd6' },
  warn: { fill: '#ffb547', line: '#ff8a3d' },
  bad: { fill: '#ff5c8a', line: '#ff3d5e' },
};

export function toneColors(tone: ChartTone): { fill: string; line: string } {
  return tone.startsWith('#') ? { fill: tone, line: tone } : TONES[tone as SparkTone];
}

export function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const p2 = (n: number) => String(n).padStart(2, '0');
const DAY_MS = 86_400_000;

/**
 * Graduation de l'axe du temps : `HH:mm` si la plage tient en 24 h, sinon `dd/MM HH:mm`. Avec un pas de graduation
 * (`incrMs`, fourni par uPlot) sous la minute, on ajoute les secondes : sinon plusieurs graduations auraient le même libellé.
 */
export function formatAxisTime(ts: number, spanMs: number, incrMs = Infinity): string {
  const d = new Date(ts);
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}${incrMs < 60_000 ? `:${p2(d.getSeconds())}` : ''}`;
  return spanMs <= DAY_MS ? hm : `${p2(d.getDate())}/${p2(d.getMonth() + 1)} ${hm}`;
}

/** Instant affiché dans l'info-bulle : à la seconde sur une plage courte, daté sinon. */
export function formatTipTime(ts: number, spanMs: number): string {
  const d = new Date(ts);
  return spanMs <= DAY_MS ? `${formatAxisTime(ts, spanMs)}:${p2(d.getSeconds())}` : formatAxisTime(ts, spanMs);
}

const trim = (n: number) => (Math.round(n * 10) / 10).toString().replace('.', ',');

/** Taille en Ko pour une graduation : « 512 Mo », « 2 Go », « 1,5 Go ». */
export function formatKBAxis(kb: number): string {
  if (kb === 0) return '0';
  if (kb >= 1024 * 1024) return `${trim(kb / (1024 * 1024))} Go`;
  if (kb >= 1024) return `${trim(kb / 1024)} Mo`;
  return `${trim(kb)} Ko`;
}

/** Pas de graduation « ronds » en Ko : puissances de 2 de 1 Mo à 4 To. */
export const KB_INCRS = Array.from({ length: 23 }, (_, i) => 1024 * 2 ** i);

/** Format d'un axe vertical : graduations, info-bulle, pas éventuels. */
export interface ValueFormat {
  fmt: (v: number) => string;
  /** Format de l'info-bulle (défaut : `fmt`). */
  tip?: (v: number) => string;
  incrs?: number[];
}

export const KB_FORMAT: ValueFormat = { fmt: formatKBAxis, tip: (v) => formatKB(Math.round(v)), incrs: KB_INCRS };
export const PERCENT_FORMAT: ValueFormat = { fmt: (v) => `${Math.round(v)} %`, incrs: [1, 2, 5, 10, 20, 25, 50, 100, 200, 400, 800, 1600] };

/** Remplissage vertical en dégradé : teinte pleine en haut de la zone de tracé, presque transparente en bas. */
export function gradientFill(color: string, top = 0.42, bottom = 0.02): (u: uPlot) => CanvasGradient | string {
  return (u) => {
    const { top: y0, height } = u.bbox;
    if (!height) return rgba(color, top);
    const g = u.ctx.createLinearGradient(0, y0, 0, y0 + height);
    g.addColorStop(0, rgba(color, top));
    g.addColorStop(1, rgba(color, bottom));
    return g;
  };
}

/** Axe stylé au thème glass. */
export function themedAxis(extra: uPlot.Axis): uPlot.Axis {
  return {
    font: AXIS_FONT,
    stroke: AXIS_COLOR,
    grid: { stroke: GRID_COLOR, width: 1 },
    ticks: { show: false },
    border: { show: false },
    gap: 6,
    ...extra,
  };
}
