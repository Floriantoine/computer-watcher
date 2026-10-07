import { expect, test } from 'vitest';
import { alertsFrom, eventMarkers, fetchMetrics, formatInstant, investigationSeries, refreshMsFor } from './metrics';

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
