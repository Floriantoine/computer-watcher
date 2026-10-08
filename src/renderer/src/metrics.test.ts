import { describe, expect, test } from 'vitest';
import {
  alertsFrom, breakdownAt, eventMarkers, fetchMetrics, formatInstant, investigationSeries, refreshMsFor, REST_KEYS, REST_LABELS, splitRest, wheelPan, wheelZoom,
  dragPan, toZoom, zoomRange,
} from './metrics';

const G = 1_048_576;

describe('splitRest (en Go)', () => {
  test('a) cas nominal : noyau = total − groupes − shmem, autres = total − top − shmem − noyau', () => {
    expect(splitRest(10 * G, 4 * G, 6 * G, 3 * G)).toEqual({ others: 2 * G, shmem: 3 * G, kernel: 1 * G });
  });
  test('b) shmem (12) > total (10) : couches nulles plutôt que négatives', () => {
    expect(splitRest(10 * G, 4 * G, 6 * G, 12 * G)).toEqual({ others: 0, shmem: 12 * G, kernel: 0 });
  });
  test('c) somme des groupes (11) > total (10), RSS double compté : noyau 0', () => {
    expect(splitRest(10 * G, 4 * G, 11 * G, 1 * G)).toEqual({ others: 5 * G, shmem: 1 * G, kernel: 0 });
  });
  test('d) shmem inconnu (avant v4) : shmem null, noyau = total − groupes', () => {
    expect(splitRest(10 * G, 4 * G, 6 * G, null)).toEqual({ others: 2 * G, shmem: null, kernel: 4 * G });
  });
  test('e) total inconnu : autres et noyau null, shmem conservé', () => {
    expect(splitRest(null, 4 * G, 6 * G, 3 * G)).toEqual({ others: null, shmem: 3 * G, kernel: null });
  });
  test('f) groupes inconnus : noyau null, autres = total − top − shmem', () => {
    expect(splitRest(10 * G, 4 * G, null, 3 * G)).toEqual({ others: 3 * G, shmem: 3 * G, kernel: null });
  });
  test('jamais de NaN ni de négatif', () => {
    for (const args of [[0, 5, 9, 9], [1, 0, null, null], [null, 0, null, null], [3, 7, 1, 0]] as [number | null, number, number | null, number | null][]) {
      for (const v of Object.values(splitRest(...args))) {
        if (v !== null) {
          expect(Number.isNaN(v)).toBe(false);
          expect(v).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

test('investigationSeries : top n, puis autres groupes, fichiers en mémoire, noyau (clés et libellés fixes)', () => {
  const series = Array.from({ length: 10 }, (_, i) => ({ key: `g${i}`, label: `G${i}`, kind: 'app' as const, memKB: [100 - i, 100 - i] }));
  const h = { ts: [0, 1], series };
  // top 8 = 100 + 99 + ... + 93 = 772 ; groupes = 945 ; total 2000 ; shmem 500
  const r = investigationSeries(h, 8, { usedKB: [2000, null], shmemKB: [500, 500], groupsKB: [945, 945] });
  expect(r.layers.map((l) => l.key)).toEqual([...series.slice(0, 8).map((s) => s.key), REST_KEYS.others, REST_KEYS.shmem, REST_KEYS.kernel]);
  expect(r.layers.slice(8).map((l) => l.label)).toEqual([REST_LABELS.others, REST_LABELS.shmem, REST_LABELS.kernel]);
  expect(REST_LABELS).toEqual({ others: 'Autres groupes', shmem: 'Fichiers en mémoire (/tmp, shm)', kernel: 'Noyau et caches' });
  const [others, shmem, kernel] = r.layers.slice(8).map((l) => l.values);
  expect(kernel).toEqual([555, null]); // 2000 − 945 − 500
  expect(others).toEqual([173, null]); // 2000 − 772 − 500 − 555
  expect(shmem).toEqual([500, 500]);
  // top + autres + shmem + noyau = total
  expect(772 + 173 + 500 + 555).toBe(2000);
});

test('breakdownAt : point le plus proche, null hors plage', () => {
  const inv = investigationSeries(
    { ts: [0, 10, 20], series: [{ key: 'a', label: 'A', kind: 'app' as const, memKB: [1, 1, 1] }] },
    8,
    { usedKB: [10, 20, 30], shmemKB: [2, 3, 4], groupsKB: [5, 5, 5] },
  );
  expect(breakdownAt(inv, 14)).toEqual({ others: 4, shmem: 3, kernel: 12 });
  expect(breakdownAt(inv, 0)).toEqual({ others: 4, shmem: 2, kernel: 3 });
  expect(breakdownAt(inv, -50)).toBeNull();
  expect(breakdownAt(inv, 100)).toBeNull();
  expect(breakdownAt({ ts: [], layers: [] }, 0)).toBeNull();
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
    system: async () => ({ ts: [0, 5], memUsedKB: [100, 100], swapUsedKB: [0, 0], memTotalKB: 1, swapTotalKB: 0, psi: [0, 0], cpu: [0, 0], load: [0, 0], shmemKB: [null, null], groupsKB: [null, null] }),
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
