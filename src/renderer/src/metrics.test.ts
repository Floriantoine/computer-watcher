import { expect, test } from 'vitest';
import { alertsFrom, eventMarkers, fetchMetrics, formatInstant, investigationSeries, refreshMsFor, wheelPan, wheelZoom, dragPan, toZoom, zoomRange } from './metrics';

test('investigationSeries : top n + Reste, valeurs brutes (courbes séparées, pas d\'empilement)', () => {
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
  expect(r.layers.map((l) => l.values)).toEqual([[10, 20], [5, null], [1, 1]]);
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
  expect(r.layers.map((l) => l.values)).toEqual([[10, 20, 30], [90, 0, 0]]);
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

test('eventMarkers : gap sans from/to, et base recréée', () => {
  const m = eventMarkers([
    { ts: 1, type: 'gap', groupKey: null, groupLabel: null, detail: { reason: 'base illisible, recréée', backup: '/x.bak' } },
    { ts: 2, type: 'gap', groupKey: null, groupLabel: null, detail: {} },
  ]);
  expect(m.map((x) => x.label)).toEqual(['Base recréée', "Trou d'enregistrement"]);
});

test('formatInstant : HH:mm:ss aujourd\'hui, dd/MM HH:mm:ss sinon', () => {
  const now = new Date(2026, 9, 7, 15, 0, 0).getTime();
  expect(formatInstant(new Date(2026, 9, 7, 9, 5, 7).getTime(), now)).toBe('09:05:07');
  expect(formatInstant(new Date(2026, 9, 5, 23, 59, 1).getTime(), now)).toBe('05/10 23:59:01');
});

test('fetchMetrics : un seul appel au top ; couches de l\'enquête = top par pic, liste Top = top par moyenne', async () => {
  const calls: unknown[] = [];
  const r = { from: 0, to: 10 };
  let topCalls = 0;
  const api = {
    system: async () => ({ ts: [0, 5], memUsedKB: [100, 100], swapUsedKB: [0, 0], memTotalKB: 1, swapTotalKB: 0, psi: [0, 0], cpu: [0, 0], load: [0, 0] }),
    events: async () => [],
    top: async (_r: unknown, o?: { limit?: number; peakLimit?: number }) => {
      topCalls++;
      calls.push(o);
      return {
        byAvg: [{ key: 'steady', label: 'T', kind: 'app' as const, avgKB: 50, maxKB: 50, spark: [] }],
        byMax: [{ key: 'spike', label: 'S', kind: 'command' as const, avgKB: 1, maxKB: 90, spark: [] }],
      };
    },
    groups: async (_r: unknown, keys?: string[]) => {
      calls.push(keys);
      return { ts: [0, 5], series: [] };
    },
  };
  const d = await fetchMetrics(api, r);
  expect(topCalls).toBe(1);
  expect(d.top.map((t) => t.key)).toEqual(['steady']);
  expect(calls).toContainEqual({ peakLimit: 8 });
  expect(calls).toContainEqual(['spike']);
});

test('refreshMsFor : 30 s jusqu\'à 24 h, jamais pour 7 j / 30 j ni en zoom', () => {
  expect(refreshMsFor('1h', false)).toBe(30_000);
  expect(refreshMsFor('6h', false)).toBe(30_000);
  expect(refreshMsFor('24h', false)).toBe(30_000);
  expect(refreshMsFor('7d', false)).toBeNull();
  expect(refreshMsFor('30d', false)).toBeNull();
  expect(refreshMsFor('1h', true)).toBeNull();
});

const M = 60_000;
const bounds = { from: 0, to: 60 * M };

test('wheelZoom : zoom avant centré sur la souris (le point sous la souris ne bouge pas)', () => {
  const r = wheelZoom(bounds, bounds, 15 * M, -100, 10 * M)!;
  expect(r.to - r.from).toBeCloseTo(48 * M, -3); // 60 / 1,25
  // 15 min est au quart de la fenêtre avant comme après
  expect((15 * M - r.from) / (r.to - r.from)).toBeCloseTo(0.25, 5);
});

test('wheelZoom : jamais sous la durée minimale, et reste dans les bornes', () => {
  const r = wheelZoom({ from: 0, to: 11 * M }, bounds, 0, -100, 10 * M)!;
  expect(r.to - r.from).toBe(10 * M);
  expect(r.from).toBe(0);
});

test('wheelZoom : dézoomer jusqu\'à la plage complète rend null (retour à la plage choisie)', () => {
  expect(wheelZoom({ from: 10 * M, to: 58 * M }, bounds, 30 * M, 100, 10 * M)).toBeNull();
  const r = wheelZoom({ from: 20 * M, to: 40 * M }, bounds, 30 * M, 100, 10 * M)!;
  expect(r.to - r.from).toBe(25 * M);
});

test('wheelPan : décale la fenêtre sans sortir des bornes ; sans zoom, rien à déplacer', () => {
  expect(wheelPan({ from: 10 * M, to: 20 * M }, bounds, 100)).toEqual({ from: 11 * M, to: 21 * M }); // 10 % de la fenêtre par cran
  expect(wheelPan({ from: 55 * M, to: 59 * M + 30_000 }, bounds, 1000)).toEqual({ from: 55 * M + 30_000, to: 60 * M });
  expect(wheelPan({ from: M, to: 11 * M }, bounds, -1000)).toEqual({ from: 0, to: 10 * M });
  expect(wheelPan(bounds, bounds, 100)).toBeNull();
});

test('toZoom : une fenêtre collée au bout (à la tolérance près) suit le direct, sinon elle est figée', () => {
  const now = 60 * M;
  expect(toZoom({ from: 40 * M, to: now }, now)).toEqual({ span: 20 * M, to: null });
  expect(toZoom({ from: 40 * M - 30_000, to: now - 30_000 }, now)).toEqual({ span: 20 * M, to: null }); // < 60 s
  expect(toZoom({ from: 30 * M, to: 50 * M }, now)).toEqual({ span: 20 * M, to: 50 * M });
});

test('zoomRange : en direct, la fenêtre avance avec le temps ; figée, elle ne bouge pas', () => {
  expect(zoomRange({ span: 20 * M, to: null }, 90 * M)).toEqual({ from: 70 * M, to: 90 * M });
  expect(zoomRange({ span: 20 * M, to: 50 * M }, 90 * M)).toEqual({ from: 30 * M, to: 50 * M });
});

test('dragPan : glisser vers la droite remonte le temps, borné ; sans zoom, rien', () => {
  // 100 px sur 1000 px d'une fenêtre de 10 min = 1 min
  expect(dragPan({ from: 20 * M, to: 30 * M }, bounds, 100, 1000)).toEqual({ from: 19 * M, to: 29 * M });
  expect(dragPan({ from: 20 * M, to: 30 * M }, bounds, -100, 1000)).toEqual({ from: 21 * M, to: 31 * M });
  expect(dragPan({ from: 55 * M, to: 59 * M }, bounds, -10_000, 1000)).toEqual({ from: 56 * M, to: 60 * M });
  expect(dragPan(bounds, bounds, 100, 1000)).toBeNull();
  expect(dragPan({ from: 20 * M, to: 30 * M }, bounds, 100, 0)).toEqual({ from: 20 * M, to: 30 * M });
});
