import type uPlot from 'uplot';
import type { GroupHistory } from '../../../../core/types';
import { stackSeries } from '../../../../core/history/series';
import type { ChartTone } from './uplotTheme';

export type ChartAxis = 'left' | 'right';

/** Série d'un TimeChart. Empilée : `values` déjà cumulées, `raw` donne la valeur propre à l'info-bulle. */
export interface ChartSeries {
  label: string;
  values: (number | null)[];
  tone: ChartTone;
  axis?: ChartAxis;
  stacked?: boolean;
  /** Aire en dégradé sous la courbe (toujours pour une série empilée). Défaut : vrai. */
  fill?: boolean;
  /** Ligne seule mise au premier plan (pleine opacité) au lieu d'être en retrait. */
  emphasis?: boolean;
  /** Pointillés uPlot, ex. [4, 4]. */
  dash?: number[];
  /** Valeurs affichées dans l'info-bulle si elles diffèrent de `values` (séries cumulées). */
  raw?: (number | null)[];
}

export function toAligned(ts: number[], series: ChartSeries[]): uPlot.AlignedData {
  return [ts, ...series.map((s) => s.values)] as uPlot.AlignedData;
}

/** Bandes uPlot : chaque série empilée remplit jusqu'à la couche empilée précédente du même axe. */
export function stackBands(series: ChartSeries[]): uPlot.Band[] {
  const bands: uPlot.Band[] = [];
  const prev: Partial<Record<ChartAxis, number>> = {};
  series.forEach((s, i) => {
    if (!s.stacked) return;
    const axis = s.axis ?? 'left';
    const below = prev[axis];
    if (below !== undefined) bands.push({ series: [i + 1, below + 1] });
    prev[axis] = i;
  });
  return bands;
}

/** Graphe du détail d'un groupe : RAM et swap empilés (axe gauche), CPU en ligne (axe droit). */
export function groupChartSeries(h: GroupHistory): ChartSeries[] {
  const [ram, ramSwap] = stackSeries([h.rssKB, h.swapKB]);
  return [
    { label: 'RAM', values: ram, raw: h.rssKB, tone: 'mem', stacked: true },
    { label: 'Swap', values: ramSwap, raw: h.swapKB, tone: 'swap', stacked: true },
    { label: 'CPU', values: h.cpu, tone: 'cpu', axis: 'right', fill: false },
  ];
}
