// Simulations de la revue (piste E) : profils réalistes de cette machine, bruit gaussien reproductible.
// Échantillon toutes les 5 s ; MemTotal 32,5 Go, swap 21,5 Go dont 6 Go libres (sous 35 % : la marge mémoire décide).
import { describe, expect, test } from 'vitest';
import { DEFAULT_THRESHOLDS as T } from './earlyoom';
import { ALERT_EVERY_MS, MarginBuffer, forecast, stepAlert, type AlertState } from './forecast';

const GO = 1024 * 1024;
const MIN = 60_000;
const STEP = 5000;
const MEM_TOTAL = 32_564_348;
const SWAP_TOTAL = 21_495_800;
const SWAP_FREE = 6_053_956;
const TH_MEM = (MEM_TOTAL * T.memPercent!) / 100;

function rng(seed: number) {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  return () => {
    let u = 0;
    let v = 0;
    while (!u) u = rnd();
    while (!v) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

/** Alertes émises (instants en ms depuis le début) pour une RAM disponible `avail(t)` (Ko). */
function simulate(avail: (t: number) => number, durMs: number, noiseMB: number, seed = 42): number[] {
  const gauss = rng(seed);
  const b = new MarginBuffer();
  let st: AlertState = { lastAlertAt: null, snoozedUntil: null, holdingSince: null };
  const alerts: number[] = [];
  for (let t = 0; t <= durMs; t += STEP) {
    const ts = 1e9 + t;
    b.push({ ts, memAvailableKB: avail(t) + gauss() * noiseMB * 1024, memTotalKB: MEM_TOTAL, swapFreeKB: SWAP_FREE, swapTotalKB: SWAP_TOTAL });
    const r = stepAlert(forecast(b.samples(), T, ts), st, ts);
    st = r.state;
    if (r.alert) alerts.push(t);
  }
  return alerts;
}

/** Dent de scie : `hi` → `lo` Go disponibles en `rampSec`, relâchée en 15 s, période `periodMin`. */
const sawtooth = (hi: number, lo: number, periodMin: number, rampSec: number) => (t: number) => {
  const p = (t % (periodMin * MIN)) / 1000;
  if (p < rampSec) return hi - (hi - lo) * (p / rampSec);
  if (p < rampSec + 15) return lo + (hi - lo) * ((p - rampSec) / 15);
  return hi;
};

describe('pic court de 40 s (−3 Go) sur un plateau bruité ou en dérive : 0 alerte sur 200 essais', () => {
  const spikeAt = 5 * MIN + 20_000;
  test.each([
    [0, 0], [10, 0], [30, 0], [100, 0], [0, -5], [0, -20], [10, -20], [100, -20],
  ])('bruit σ = %d Mo, dérive %d Mo/min', (noise, drift) => {
    let hit = 0;
    for (let i = 0; i < 200; i++) {
      const base = 4 * GO + TH_MEM;
      const f = (t: number) => base + drift * 1024 * (t / MIN) - (t > spikeAt ? Math.min(1, (t - spikeAt) / 40_000) * 3 * GO : 0);
      if (simulate(f, spikeAt + 40_000, noise, 1000 + i).length) hit++;
    }
    expect(hit).toBe(0);
  });
});

test('légère dérive sur 2 h (−20 Mo/min depuis 6 Go de marge, σ = 50 Mo) : 0 alerte', () => {
  expect(simulate((t) => 6 * GO + TH_MEM - 20 * 1024 * (t / MIN), 120 * MIN, 50)).toEqual([]);
});

test('pic de 40 s qui revient, toutes les 4 min pendant 2 h : 0 alerte', () => {
  const base = 4 * GO + TH_MEM;
  const f = (t: number) => {
    const p = t % (4 * MIN);
    return base - (p > 3 * MIN && p < 3 * MIN + 40_000 ? 3 * GO : 0);
  };
  expect(simulate(f, 120 * MIN, 20)).toEqual([]);
});

describe('dent de scie de Claude 8 → 28 Go utilisés (24 → 4 Go disponibles), 3 h, σ = 50 Mo : 0 alerte', () => {
  test.each([
    [3, 120], [4, 60], [4, 120], [4, 180], [5, 180], [5, 240], [6, 300], [8, 300],
  ])('période %d min, montée %d s', (period, ramp) => {
    expect(simulate(sawtooth(24 * GO, 4 * GO, period, ramp), 180 * MIN, 50)).toEqual([]);
  });
});

describe('dent de scie douce 15 → 8 Go disponibles, 3 h, σ = 50 Mo : 0 alerte', () => {
  test.each([[4, 120], [5, 240], [5, 270], [6, 300]])('période %d min, montée %d s', (period, ramp) => {
    expect(simulate(sawtooth(15 * GO, 8 * GO, period, ramp), 180 * MIN, 50)).toEqual([]);
  });
});

describe('vraie fuite qui franchit le plancher : alerte, au plus une fois par 30 min', () => {
  test('−1 Go/min depuis 16 Go disponibles', () => {
    const a = simulate((t) => Math.max(0, 16 * GO - GO * (t / MIN)), 16 * MIN, 50);
    expect(a.length).toBe(1);
    expect(a[0]!).toBeGreaterThan(9 * MIN); // pas avant que la marge passe sous le plancher (~3,1 Go)
  });
  test('−400 Mo/min depuis 6 Go disponibles', () => {
    expect(simulate((t) => Math.max(0, 6 * GO - 400 * 1024 * (t / MIN)), 14 * MIN, 50)).toHaveLength(1);
  });
  test('fuite lente (−150 Mo/min) qui dure 1 h 30 sur une grosse machine : une alerte par 30 min au plus', () => {
    // 128 Go : seuil earlyoom 10,2 Go, plancher 12,8 Go ; la marge reste longtemps sous le plancher
    const total = 128 * GO;
    const gauss = rng(9);
    const b = new MarginBuffer();
    let st: AlertState = { lastAlertAt: null, snoozedUntil: null, holdingSince: null };
    const alerts: number[] = [];
    for (let t = 0; t <= 90 * MIN; t += STEP) {
      const ts = 1e9 + t;
      const avail = Math.max(0, 12 * GO - 150 * 1024 * (t / MIN)) + gauss() * 20 * 1024;
      b.push({ ts, memAvailableKB: avail, memTotalKB: total, swapFreeKB: 0, swapTotalKB: 0 });
      const r = stepAlert(forecast(b.samples(), T, ts), st, ts);
      st = r.state;
      if (r.alert) alerts.push(t);
    }
    expect(alerts.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < alerts.length; i++) expect(alerts[i]! - alerts[i - 1]!).toBeGreaterThanOrEqual(ALERT_EVERY_MS);
  });
});
