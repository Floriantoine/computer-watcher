import { describe, expect, test } from 'vitest';
import { DEFAULT_THRESHOLDS } from './earlyoom';
import {
  ALERT_EVERY_MS, MarginBuffer, alertText, forecast, formatGo, marginKB, shouldAlert, type AlertState, type MarginSample,
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
const fresh: AlertState = { lastAlertAt: null, snoozedUntil: null };

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

describe('forecast et shouldAlert', () => {
  test('swap à 82 % utilisé, RAM libre à 50 %, stable 5 min → pas d’alerte (Review Focus 1)', () => {
    const samples = ramp(NOW, 0, 0, 6).map((s) => ({ ...s, memAvailableKB: 16 * GO, swapFreeKB: 0.18 * 20 * GO }));
    const f = forecast(samples, T, NOW);
    expect(f).not.toBeNull();
    expect(f!.etaMin).toBeNull();
    expect(shouldAlert(f, fresh, NOW)).toBe(false);
  });

  test('baisse régulière de 1 Go/min depuis 6 Go → ETA ≈ 6 min, 5 minutes en baisse, alerte', () => {
    // la marge atteint 6 Go à NOW : départ 12 Go six minutes plus tôt
    const f = forecast(ramp(NOW, 12 * GO, -GO, 6), T, NOW)!;
    expect(f.etaMin!).toBeGreaterThan(5.8);
    expect(f.etaMin!).toBeLessThan(6.2);
    expect(f.decliningMinutes).toBe(5);
    expect(f.slopeKBPerMin).toBeCloseTo(-GO, -2);
    expect(shouldAlert(f, fresh, NOW)).toBe(true);
  });

  test('pic court : stable 4 min 20 s puis −3 Go en 40 s → pas d’alerte (Review Focus 1)', () => {
    const stable = ramp(NOW - 40_000, 4 * GO, 0, 5 + 20 / 60);
    const spike = ramp(NOW, 4 * GO, (-3 * GO) / (40 / 60), 40 / 60).slice(1);
    const f = forecast([...stable, ...spike], T, NOW)!;
    expect(f.etaMin).not.toBeNull(); // la pente est négative…
    expect(f.etaMin!).toBeLessThan(10); // … et l'ETA brute sous 10 min
    expect(f.decliningMinutes).toBeLessThanOrEqual(1);
    expect(shouldAlert(f, fresh, NOW)).toBe(false);
  });

  test('même pic suivi d’un retour → pas d’alerte', () => {
    const end = NOW;
    const samples = ramp(end, 4 * GO, 0, 6).map((s) => (s.ts > end - 80_000 && s.ts <= end - 40_000 ? sample(s.ts, 1 * GO) : s));
    expect(shouldAlert(forecast(samples, T, end), fresh, end)).toBe(false);
  });

  test('pic de 2 min (vitest long) → au plus 2 minutes en baisse, pas d’alerte', () => {
    const stable = ramp(NOW - 2 * MIN, 6 * GO, 0, 4);
    const fall = ramp(NOW, 6 * GO, -2 * GO, 2).slice(1);
    const f = forecast([...stable, ...fall], T, NOW)!;
    expect(f.decliningMinutes).toBeLessThanOrEqual(2);
    expect(shouldAlert(f, fresh, NOW)).toBe(false);
  });

  test('baisse lente (−100 Mo/min, 8 Go) → ETA ~80 min, pas d’alerte', () => {
    const f = forecast(ramp(NOW, 8 * GO + 600 * 1024, -100 * 1024, 6), T, NOW)!;
    expect(f.etaMin!).toBeGreaterThan(70);
    expect(shouldAlert(f, fresh, NOW)).toBe(false);
  });

  test('marge qui monte → etaMin null', () => {
    expect(forecast(ramp(NOW, 2 * GO, GO, 6), T, NOW)!.etaMin).toBeNull();
  });

  test('marge déjà nulle et en baisse → etaMin 0', () => {
    expect(forecast(ramp(NOW, GO, -GO, 6), T, NOW)!.etaMin).toBe(0);
  });

  test('moins de 4 min de données, ou 11 échantillons → null', () => {
    expect(forecast(ramp(NOW, 12 * GO, -GO, 3.5), T, NOW)).toBeNull();
    expect(forecast(ramp(NOW, 12 * GO, -GO, 5, 30).slice(0, 11), T, NOW)).toBeNull();
    expect(shouldAlert(null, fresh, NOW)).toBe(false);
  });

  test('anti-répétition : 30 min entre deux alertes ; « Ignorer 30 min » repousse', () => {
    const f = forecast(ramp(NOW, 12 * GO, -GO, 6), T, NOW)!;
    const t = NOW;
    expect(shouldAlert(f, { lastAlertAt: t, snoozedUntil: null }, t + 29 * MIN)).toBe(false);
    expect(shouldAlert(f, { lastAlertAt: t, snoozedUntil: null }, t + ALERT_EVERY_MS)).toBe(true);
    const snoozed = { lastAlertAt: null, snoozedUntil: t + 40 * MIN };
    expect(shouldAlert(f, snoozed, t + 39 * MIN)).toBe(false);
    expect(shouldAlert(f, snoozed, t + 40 * MIN)).toBe(true);
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
  const f = (etaMin: number) => ({ marginKB: 0, slopeKBPerMin: -1, etaMin, decliningMinutes: 5, spanMin: 5 });
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
