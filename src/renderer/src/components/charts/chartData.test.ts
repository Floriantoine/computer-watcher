import { expect, test } from 'vitest';
import { groupChartSeries, markerLook, seriesIndexOf, stackBands, toAligned, type ChartSeries } from './chartData';

const s = (p: Partial<ChartSeries>): ChartSeries => ({ label: 'x', values: [], tone: 'mem', ...p });

test('données alignées : ts puis une colonne par série', () => {
  expect(toAligned([1, 2], [s({ values: [3, null] }), s({ values: [5, 6] })])).toEqual([[1, 2], [3, null], [5, 6]]);
});
test('bandes : chaque couche empilée vers la précédente du même axe', () => {
  const series = [s({ stacked: true }), s({ axis: 'right' }), s({ stacked: true }), s({ stacked: true, axis: 'right' }), s({ stacked: true })];
  expect(stackBands(series)).toEqual([{ series: [3, 1] }, { series: [5, 3] }]);
});
test('graphe du groupe : RAM puis swap cumulé (valeur brute en info-bulle), CPU à droite', () => {
  const out = groupChartSeries({ ts: [1, 2], rssKB: [10, null], swapKB: [1, 2], cpu: [5, null] });
  expect(out.map((x) => [x.label, x.axis ?? 'left', !!x.stacked])).toEqual([['RAM', 'left', true], ['Swap', 'left', true], ['CPU', 'right', false]]);
  expect(out[0].values).toEqual([10, 0]);
  expect(out[1].values).toEqual([11, 2]);
  expect(out[1].raw).toEqual([1, 2]);
  expect(out[0].raw).toEqual([10, null]);
  expect(out[2].values).toEqual([5, null]);
});

test('mise en avant d\'une courbe : index de la série de ce groupe, sinon null', () => {
  expect(seriesIndexOf(['a', 'b', '__rest'], 'b')).toBe(1);
  expect(seriesIndexOf(['a', 'b'], 'z')).toBeNull(); // groupe hors du graphe
  expect(seriesIndexOf(['a'], null)).toBeNull();
});
test('mise en avant d\'un marqueur : survolé = net et épais, les autres estompés, aucun survol = normal', () => {
  expect(markerLook(10, null)).toEqual({ alpha: 0.7, width: 1, label: false });
  expect(markerLook(10, 10)).toEqual({ alpha: 1, width: 2, label: true });
  expect(markerLook(10, 20)).toEqual({ alpha: 0.2, width: 1, label: false });
});
