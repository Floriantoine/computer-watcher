import { expect, test } from 'vitest';
import { ProcGrowth } from './growth';

const p = (pid: number, kb: number, startTicks = pid * 10) => ({ pid, startTicks, rssKB: kb, swapKB: 0 });
const MIN = 60_000;

test('croissance par processus sur 5 min ; nouveau processus : toute sa mémoire ; pid réutilisé : autre processus', () => {
  const g = new ProcGrowth(5_000);
  for (let t = 0; t <= 5 * MIN; t += 5000) g.push(t, [p(1, 1000 + t / 1000), p(2, 500), ...(t >= 4 * MIN ? [p(3, 300)] : [])]);
  const m = g.growth(5 * MIN)!;
  expect(m.get('1:10')).toBe(300);
  expect(m.get('2:20')).toBe(0);
  expect(m.get('3:30')).toBe(300);
  g.push(5 * MIN + 5000, [p(1, 2000, 999)]);
  expect(g.growth(5 * MIN + 5000)!.get('1:999')).toBe(2000);
});

test('moins de 5 min d’historique → null ; trou (> 4 × intervalle) → historique vidé', () => {
  const g = new ProcGrowth(5_000);
  for (let t = 0; t <= 4 * MIN; t += 5000) g.push(t, [p(1, 1000)]);
  expect(g.growth(4 * MIN)).toBeNull();
  for (let t = 4 * MIN + 5000; t <= 6 * MIN; t += 5000) g.push(t, [p(1, 1000)]);
  expect(g.growth(6 * MIN)).not.toBeNull();
  g.push(6 * MIN + 21_000, [p(1, 5000)]); // 21 s > 4 × 5 s
  expect(g.growth(6 * MIN + 21_000)).toBeNull();
});

test('horloge qui recule → historique vidé ; garde au plus ~6 min d’instantanés', () => {
  const g = new ProcGrowth(5_000);
  for (let t = 0; t <= 20 * MIN; t += 5000) g.push(t, [p(1, 1)]);
  expect(g.snapshots()).toBeLessThanOrEqual(14);
  g.push(0, [p(1, 1)]);
  expect(g.growth(0)).toBeNull();
});
