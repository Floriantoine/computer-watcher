import { expect, test } from 'vitest';
import { alertsFrom, eventMarkers, investigationSeries } from './metrics';

test('investigationSeries : top n + Reste, cumulé', () => {
  const h = {
    ts: [0, 1],
    series: [
      { key: 'a', label: 'A', kind: 'app' as const, memKB: [10, 20] },
      { key: 'b', label: 'B', kind: 'app' as const, memKB: [5, null] },
      { key: 'c', label: 'C', kind: 'app' as const, memKB: [1, 1] },
    ],
  };
  const r = investigationSeries(h, 2);
  expect(r.layers.map((l) => l.label)).toEqual(['A', 'B', 'Reste']);
  expect(r.layers.map((l) => l.values)).toEqual([[10, 20], [15, 20], [16, 21]]);
});

test('investigationSeries : Reste = total système − top n (jamais négatif)', () => {
  const h = {
    ts: [0, 1, 2],
    series: [
      { key: 'a', label: 'A', kind: 'app' as const, memKB: [10, 20, 30] },
      { key: 'b', label: 'B', kind: 'app' as const, memKB: [5, null, 5] },
    ],
  };
  const r = investigationSeries(h, 1, [100, null, 20]);
  expect(r.layers.map((l) => l.label)).toEqual(['A', 'Reste']);
  // Le groupe B, hors du top, est compris dans le Reste ; total inconnu → Reste nul.
  expect(r.layers.map((l) => l.values)).toEqual([[10, 20, 30], [100, 20, 30]]);
});

test('eventMarkers : couleurs et libellés', () => {
  const m = eventMarkers([
    { ts: 1, type: 'earlyoom_kill', groupKey: null, groupLabel: null, detail: { name: 'chrome' } },
    { ts: 2, type: 'pressure', groupKey: null, groupLabel: null, detail: { psi: 31.4 } },
    { ts: 3, type: 'gap', groupKey: null, groupLabel: null, detail: { from: 0, to: 240_000 } },
    { ts: 4, type: 'leak', groupKey: 'app:claude', groupLabel: 'Claude', detail: { growthKB: 4 * 1024 * 1024 } },
  ]);
  expect(m.map((x) => x.label)).toEqual(['Kill earlyoom : chrome', 'Pression 31 %', "Trou d'enregistrement (4 min)", 'Fuite probable : Claude +4,0 Go']);
  expect(m.map((x) => x.color)).toEqual(['#ff5c8a', '#ffb547', '#8b91a0', '#ff8a3d']);
});

test('alertsFrom : récents d\'abord, sans app_kill', () => {
  const ev = (ts: number, type: string) => ({ ts, type, groupKey: null, groupLabel: null, detail: {} });
  expect(alertsFrom([ev(1, 'leak'), ev(2, 'app_kill'), ev(3, 'gap')]).map((e) => e.ts)).toEqual([3, 1]);
});
