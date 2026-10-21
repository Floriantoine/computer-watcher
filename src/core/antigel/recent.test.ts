import { expect, test } from 'vitest';
import { RECENT_MS, createRecent } from './recent';

const S = 1000;

test('aucun événement « high » dans la dernière minute : rien à publier, même si le cgroup attend la mémoire', () => {
  const r = createRecent();
  r.push({ at: 0, high: 3, stallUs: 0 });
  r.push({ at: 5 * S, high: 3, stallUs: 4_000_000 });
  expect(r.pct()).toBeUndefined();
});

test('freiné : part du temps passé à attendre la mémoire (PSI « some ») sur la fenêtre', () => {
  const r = createRecent();
  r.push({ at: 10 * S, high: 2, stallUs: 0 });
  r.push({ at: 15 * S, high: 5, stallUs: 2_500_000 });
  expect(r.pct()).toBe(50);
  r.push({ at: 31 * S, high: 5, stallUs: 2_500_000 });
  expect(r.pct()).toBe(12); // 2,5 s sur 21 s
  // plus d'une minute sans nouvel événement : sorti de la fenêtre
  r.push({ at: 91 * S, high: 5, stallUs: 2_500_000 });
  expect(r.pct()).toBeUndefined();
});

test('sans memory.pressure : part des intervalles où le compteur « high » a augmenté', () => {
  const r = createRecent();
  r.push({ at: 0, high: 0, stallUs: null });
  r.push({ at: 5 * S, high: 4, stallUs: null });
  r.push({ at: 10 * S, high: 4, stallUs: null });
  r.push({ at: 15 * S, high: 4, stallUs: null });
  r.push({ at: 20 * S, high: 4, stallUs: null });
  expect(r.pct()).toBe(25);
});

test('compteur remis à zéro (slice recréée) : pas un freinage ; borné à 100 % ; fenêtre bornée en taille', () => {
  const r = createRecent();
  r.push({ at: 0, high: 50, stallUs: 9_000_000 });
  r.push({ at: 5 * S, high: 0, stallUs: 0 });
  expect(r.pct()).toBeUndefined();
  r.push({ at: 6 * S, high: 1, stallUs: 5_000_000 });
  expect(r.pct()).toBe(100);
  for (let k = 0; k < 1000; k++) r.push({ at: 7 * S + k * 10, high: 1, stallUs: 5_000_000 });
  expect(r.size()).toBeLessThanOrEqual(RECENT_MS / 1000 + 2);
});
