import { describe, expect, test } from 'vitest';
import {
  alertsFrom, breakdownAt, eventMarkers, fetchMetrics, formatInstant, investigationSeries, refreshMsFor, REST_HINTS, REST_KEYS, REST_LABELS, splitRest, wheelPan, wheelZoom,
  dragPan, toZoom, zoomRange,
} from './metrics';

const G = 1_048_576;

describe('splitRest (en Go)', () => {
  test('a) autres = somme réelle des groupes hors top (groupes − top), noyau = total − groupes − shmem', () => {
    expect(splitRest(10 * G, 4 * G, 6 * G, 3 * G)).toEqual({ others: 2 * G, shmem: 3 * G, kernel: 1 * G });
  });
  test('b) shmem (12) > total (10) : noyau 0, autres inchangés', () => {
    expect(splitRest(10 * G, 4 * G, 6 * G, 12 * G)).toEqual({ others: 2 * G, shmem: 12 * G, kernel: 0 });
  });
  test('c) groupes (11) > total (10), RSS double compté : noyau 0, autres = vraie somme hors top (7)', () => {
    expect(splitRest(10 * G, 4 * G, 11 * G, 1 * G)).toEqual({ others: 7 * G, shmem: 1 * G, kernel: 0 });
  });
  test('d) shmem inconnu (avant v4) : noyau inconnu (n’absorbe pas Shmem), autres connus', () => {
    expect(splitRest(10 * G, 4 * G, 6 * G, null)).toEqual({ others: 2 * G, shmem: null, kernel: null });
  });
  test('e) total inconnu : noyau null, autres et shmem conservés', () => {
    expect(splitRest(null, 4 * G, 6 * G, 3 * G)).toEqual({ others: 2 * G, shmem: 3 * G, kernel: null });
  });
  test('f) groupes inconnus : autres et noyau null, sauf si les séries hors top sont chargées', () => {
    expect(splitRest(10 * G, 4 * G, null, 3 * G)).toEqual({ others: null, shmem: 3 * G, kernel: null });
    expect(splitRest(10 * G, 4 * G, null, 3 * G, 5 * G)).toEqual({ others: 5 * G, shmem: 3 * G, kernel: null });
  });
  test('g) somme des séries hors top chargées prioritaire sur groupes − top', () => {
    expect(splitRest(10 * G, 4 * G, 6 * G, 1 * G, 2.5 * G).others).toBe(2.5 * G);
  });
  test('jamais de NaN ni de négatif', () => {
    for (const args of [[0, 5, 3, 9], [1, 0, null, null], [null, 0, null, null], [3, 7, 1, 0]] as [number | null, number, number | null, number | null][]) {
      for (const v of Object.values(splitRest(...args))) {
        if (v !== null) {
          expect(Number.isNaN(v)).toBe(false);
          expect(v).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

test('investigationSeries : top n, puis autres groupes, fichiers en mémoire, noyau (estimation)', () => {
  const series = Array.from({ length: 10 }, (_, i) => ({ key: `g${i}`, label: `G${i}`, kind: 'app' as const, memKB: [100 - i, 100 - i] }));
  const totals = { usedKB: [2000, null], shmemKB: [500, 500], groupsKB: [955, 955] };
  // top 8 = 100 + … + 93 = 772 ; hors top chargés : 92 + 91 = 183
  const r = investigationSeries({ ts: [0, 1], series }, 8, totals);
  expect(r.layers.map((l) => l.key)).toEqual([...series.slice(0, 8).map((s) => s.key), REST_KEYS.others, REST_KEYS.shmem, REST_KEYS.kernel]);
  expect(r.layers.slice(8).map((l) => l.label)).toEqual([REST_LABELS.others, REST_LABELS.shmem, REST_LABELS.kernel]);
  expect(REST_LABELS).toEqual({ others: 'Autres groupes', shmem: 'Fichiers en mémoire (/tmp, shm)', kernel: 'Noyau et caches (estimation)' });
  expect(REST_HINTS.kernel).toMatch(/pages partagées/);
  expect(REST_HINTS.kernel).toMatch(/minimum/);
  const [others, shmem, kernel] = r.layers.slice(8).map((l) => l.values);
  expect(others).toEqual([183, 183]); // vraie somme des séries hors top
  expect(shmem).toEqual([500, 500]);
  expect(kernel).toEqual([545, null]); // 2000 − 955 − 500
  // seulement le top chargé (cas de l'app) : autres = groupes − top
  const topOnly = investigationSeries({ ts: [0, 1], series: series.slice(0, 8) }, 8, totals);
  expect(topOnly.layers.find((l) => l.key === REST_KEYS.others)!.values).toEqual([183, 183]);
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

test('événement tmpfs : marqueur fuchsia « Fichiers en mémoire : 7,8 Go », gardé dans les alertes', () => {
  const e = { ts: 1, type: 'tmpfs', groupKey: null, groupLabel: null, detail: { shmemKB: 8191000, thresholdKB: 2097152 } };
  expect(eventMarkers([e])).toEqual([{ ts: 1, type: 'tmpfs', color: '#e879f9', label: 'Fichiers en mémoire : 7,8 Go' }]);
  expect(alertsFrom([e])).toEqual([e]);
});

test('eventMarkers : prévision ② « Épuisement prévu dans ~8 min », orange ; alertsFrom la garde', () => {
  const e = { ts: 5, type: 'forecast', groupKey: null, groupLabel: null, detail: { etaMin: 7.6 } };
  expect(eventMarkers([e])[0]).toMatchObject({ label: 'Épuisement prévu dans ~8 min', color: '#ffb547' });
  expect(eventMarkers([{ ...e, detail: { etaMin: 0.3 } }])[0]!.label).toBe("Épuisement prévu dans moins d'une minute");
  expect(alertsFrom([e])).toHaveLength(1);
});
