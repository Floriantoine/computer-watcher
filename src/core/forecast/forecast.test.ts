import { describe, expect, test } from 'vitest';
import { DEFAULT_THRESHOLDS } from './earlyoom';
import {
  ALERT_EVERY_MS, MarginBuffer, alertCondition, alertText, floorKB, forecast, formatGo, marginKB, stepAlert, type AlertState, type MarginSample,
} from './forecast';

const GO = 1024 * 1024;
const MIN = 60_000;
const T = DEFAULT_THRESHOLDS; // 8 % / 35 %
const MEM_TOTAL = 32 * GO;
const MEM_THRESHOLD = 0.08 * MEM_TOTAL;

/** Échantillon dont la marge mémoire vaut `margin` (swap sous son seuil : seule la mémoire compte). */
const sample = (ts: number, margin: number): MarginSample => ({
  ts, memAvailableKB: margin + MEM_THRESHOLD, memTotalKB: MEM_TOTAL, swapFreeKB: 2 * GO, swapTotalKB: 20 * GO,
});

/** `minutes` minutes d'échantillons toutes les `everySec` s, finissant à `end`, marge `start` puis `perMin` Ko/min. */
function ramp(end: number, start: number, perMin: number, minutes: number, everySec = 5): MarginSample[] {
  const out: MarginSample[] = [];
  const n = Math.round((minutes * 60) / everySec);
  for (let i = 0; i <= n; i++) {
    const ts = end - (n - i) * everySec * 1000;
    out.push(sample(ts, start + (perMin * (i * everySec)) / 60));
  }
  return out;
}

const NOW = 100 * MIN;
const fresh: AlertState = { lastAlertAt: null, snoozedUntil: null, holdingSince: null };

describe('marginKB', () => {
  test('swap libre sous son seuil : la marge mémoire décide', () => {
    const s: MarginSample = { ts: 0, memAvailableKB: 16 * GO, memTotalKB: MEM_TOTAL, swapFreeKB: 4 * GO, swapTotalKB: 20 * GO };
    expect(marginKB(s, T)).toBeCloseTo(16 * GO - MEM_THRESHOLD, 0);
  });
  test('beaucoup de swap libre : la marge swap décide (max)', () => {
    const s: MarginSample = { ts: 0, memAvailableKB: 3 * GO, memTotalKB: MEM_TOTAL, swapFreeKB: 18 * GO, swapTotalKB: 20 * GO };
    expect(marginKB(s, T)).toBeCloseTo(18 * GO - 7 * GO, 0);
  });
  test('sans swap : marge mémoire seule', () => {
    const s: MarginSample = { ts: 0, memAvailableKB: 4 * GO, memTotalKB: MEM_TOTAL, swapFreeKB: 0, swapTotalKB: 0 };
    expect(marginKB(s, T)).toBeCloseTo(4 * GO - MEM_THRESHOLD, 0);
  });
});

describe('forecast et alertCondition', () => {
  test('swap à 82 % utilisé, RAM libre à 50 %, stable 5 min → pas d’alerte (Review Focus 1)', () => {
    const samples = ramp(NOW, 0, 0, 6).map((s) => ({ ...s, memAvailableKB: 16 * GO, swapFreeKB: 0.18 * 20 * GO }));
    const f = forecast(samples, T, NOW);
    expect(f).not.toBeNull();
    expect(f!.etaMin).toBeNull();
    expect(alertCondition(f)).toBe(false);
  });

  test('plancher = max(2 Gio, 10 % de la RAM)', () => {
    expect(floorKB(32 * GO)).toBeCloseTo(3.2 * GO, 0);
    expect(floorKB(8 * GO)).toBe(2 * GO);
  });

  test('baisse régulière de 1 Go/min jusqu’à 3 Go (sous le plancher) → ETA ≈ 3 min, 5 minutes en baisse, condition vraie', () => {
    const f = forecast(ramp(NOW, 9 * GO, -GO, 6), T, NOW)!;
    expect(f.etaMin!).toBeGreaterThan(2.8);
    expect(f.etaMin!).toBeLessThan(3.2);
    expect(f.decliningMinutes).toBe(5);
    expect(f.slopeKBPerMin).toBeCloseTo(-GO, -2);
    expect(f.floorKB).toBeCloseTo(3.2 * GO, 0);
    expect(alertCondition(f)).toBe(true);
  });

  test('même baisse mais marge encore au-dessus du plancher (6 Go) → condition fausse malgré ETA ≈ 6 min', () => {
    const f = forecast(ramp(NOW, 12 * GO, -GO, 6), T, NOW)!;
    expect(f.etaMin!).toBeLessThan(10);
    expect(alertCondition(f)).toBe(false);
  });

  test('baisse de 100 Mo/min (sous la baisse minimale de 128 Mio/min), marge sous le plancher → condition fausse', () => {
    const f = forecast(ramp(NOW, GO / 2 + 600 * 1024, -100 * 1024, 6), T, NOW)!;
    expect(f.etaMin!).toBeLessThan(10);
    expect(f.decliningMinutes).toBe(0);
    expect(alertCondition(f)).toBe(false);
  });

  test('pic court : stable 4 min 20 s puis −3 Go en 40 s → condition fausse (Review Focus 1)', () => {
    const stable = ramp(NOW - 40_000, 4 * GO, 0, 5 + 20 / 60);
    const spike = ramp(NOW, 4 * GO, (-3 * GO) / (40 / 60), 40 / 60).slice(1);
    const f = forecast([...stable, ...spike], T, NOW)!;
    expect(f.etaMin!).toBeLessThan(10); // ETA brute sous 10 min et marge sous le plancher…
    expect(f.marginKB).toBeLessThan(f.floorKB);
    expect(f.decliningMinutes).toBeLessThanOrEqual(1); // … mais une seule minute en baisse
    expect(alertCondition(f)).toBe(false);
  });

  test('pic de 2 min → au plus 2 minutes en baisse, condition fausse', () => {
    const stable = ramp(NOW - 2 * MIN, 4 * GO, 0, 4);
    const fall = ramp(NOW, 4 * GO, -1.5 * GO, 2).slice(1);
    const f = forecast([...stable, ...fall], T, NOW)!;
    expect(f.decliningMinutes).toBeLessThanOrEqual(2);
    expect(alertCondition(f)).toBe(false);
  });

  test('marge qui monte → etaMin null ; marge déjà nulle et en baisse → etaMin 0', () => {
    expect(forecast(ramp(NOW, 2 * GO, GO, 6), T, NOW)!.etaMin).toBeNull();
    expect(forecast(ramp(NOW, GO, -GO, 6), T, NOW)!.etaMin).toBe(0);
  });

  test('moins de 4 min de données → null ; moins de 5 échantillons → null', () => {
    expect(forecast(ramp(NOW, 12 * GO, -GO, 3.5), T, NOW)).toBeNull();
    expect(forecast(ramp(NOW, 12 * GO, -GO, 5, 75).slice(-4), T, NOW)).toBeNull();
    expect(alertCondition(null)).toBe(false);
  });

  test('intervalle long (60 s) : 6 échantillons en 5 min suffisent', () => {
    const f = forecast(ramp(NOW, 9 * GO, -GO, 6, 60), T, NOW)!;
    expect(f).not.toBeNull();
    expect(f.decliningMinutes).toBe(5);
    expect(alertCondition(f)).toBe(true);
  });
});

describe('stepAlert : condition tenue 30 s, anti-répétition, « Ignorer 30 min »', () => {
  const f = forecast(ramp(NOW, 9 * GO, -GO, 6), T, NOW)!;
  const calm = forecast(ramp(NOW, 16 * GO, 0, 6), T, NOW);

  test('une seule évaluation vraie ne suffit pas ; vraie encore 30 s plus tard → alerte', () => {
    let r = stepAlert(f, fresh, NOW);
    expect(r.alert).toBe(false);
    r = stepAlert(f, r.state, NOW + 25_000);
    expect(r.alert).toBe(false);
    r = stepAlert(f, r.state, NOW + 30_000);
    expect(r.alert).toBe(true);
    expect(r.state.lastAlertAt).toBe(NOW + 30_000);
  });

  test('condition interrompue deux fois de suite → le compte repart', () => {
    let r = stepAlert(f, fresh, NOW);
    r = stepAlert(calm, r.state, NOW + 15_000);
    r = stepAlert(calm, r.state, NOW + 20_000);
    r = stepAlert(f, r.state, NOW + 35_000);
    expect(r.alert).toBe(false);
    r = stepAlert(f, r.state, NOW + 65_000);
    expect(r.alert).toBe(true);
  });

  test('épisode coupé en deux par UNE évaluation manquée : la tenue continue (cas réel de la revue)', () => {
    let r = stepAlert(f, fresh, NOW);
    r = stepAlert(f, r.state, NOW + 5000);
    r = stepAlert(calm, r.state, NOW + 10_000); // un seul tick hors condition
    expect(r.state.holdingSince).toBe(NOW);
    r = stepAlert(f, r.state, NOW + 15_000);
    r = stepAlert(f, r.state, NOW + 25_000);
    expect(r.alert).toBe(false);
    r = stepAlert(f, r.state, NOW + 30_000);
    expect(r.alert).toBe(true);
  });

  test('deux évaluations manquées (consécutives ou non) pendant la tenue → le compte repart', () => {
    let r = stepAlert(f, fresh, NOW);
    r = stepAlert(calm, r.state, NOW + 5000);
    r = stepAlert(calm, r.state, NOW + 10_000);
    r = stepAlert(f, r.state, NOW + 30_000);
    expect(r.alert).toBe(false);
    let q = stepAlert(f, fresh, NOW);
    q = stepAlert(calm, q.state, NOW + 5000);
    q = stepAlert(f, q.state, NOW + 10_000);
    q = stepAlert(calm, q.state, NOW + 15_000);
    q = stepAlert(f, q.state, NOW + 30_000);
    expect(q.alert).toBe(false);
    expect(q.state.holdingSince).toBe(NOW + 30_000);
  });

  test('anti-répétition : 30 min entre deux alertes', () => {
    const held = { lastAlertAt: NOW, snoozedUntil: null, holdingSince: NOW - MIN };
    expect(stepAlert(f, held, NOW + 29 * MIN).alert).toBe(false);
    expect(stepAlert(f, held, NOW + ALERT_EVERY_MS).alert).toBe(true);
  });

  test('« Ignorer 30 min » repousse', () => {
    const snoozed = { lastAlertAt: null, snoozedUntil: NOW + 40 * MIN, holdingSince: NOW - MIN };
    expect(stepAlert(f, snoozed, NOW + 39 * MIN).alert).toBe(false);
    expect(stepAlert(f, snoozed, NOW + 40 * MIN).alert).toBe(true);
  });
});

test('MarginBuffer : garde 6 min, ordre préservé', () => {
  const b = new MarginBuffer();
  for (let i = 0; i <= 100; i++) b.push(sample(i * 5000, i));
  const s = b.samples();
  expect(s[s.length - 1]!.ts).toBe(500_000);
  expect(s[0]!.ts).toBe(500_000 - 360_000);
  expect(s.every((x, i) => i === 0 || x.ts > s[i - 1]!.ts)).toBe(true);
});

describe('textes', () => {
  const f = (etaMin: number) => ({ marginKB: 0, floorKB: 0, slopeKBPerMin: -1, etaMin, decliningMinutes: 5, spanMin: 5 });
  test('titre arrondi à la minute ; moins d’une minute', () => {
    expect(alertText(f(7.6), [], 82).title).toBe('Mémoire épuisée dans ~8 min');
    expect(alertText(f(0.4), [], 82).title).toBe("Mémoire épuisée dans moins d'une minute");
  });
  test('corps : 2 groupes qui grossissent puis le swap ; deltas ≤ 0 ignorés', () => {
    const top = [
      { label: 'Claude', deltaKB: 3_250_000 },
      { label: 'vitest', deltaKB: 1_258_291 },
      { label: 'chrome', deltaKB: 900_000 },
    ];
    expect(alertText(f(7.6), top, 82).body).toBe('Claude +3,1 Go en 5 min · vitest +1,2 Go en 5 min · swap 82 %');
    expect(alertText(f(7.6), [{ label: 'x', deltaKB: -5 }, { label: 'y', deltaKB: 0 }], 82.4).body).toBe('swap 82 %');
  });
  test('sans swap : pas de mention du swap', () => {
    expect(alertText(f(3), [{ label: 'Claude', deltaKB: 3_250_000 }], null).body).toBe('Claude +3,1 Go en 5 min');
  });
  test('formatGo', () => {
    expect(formatGo(3_250_000)).toBe('3,1 Go');
    expect(formatGo(819_200)).toBe('800 Mo');
  });
});
