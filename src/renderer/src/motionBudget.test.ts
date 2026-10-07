import { describe, expect, test } from 'vitest';
import { formatKB } from './format';
import { barWidth, tweenSteps, TWEEN_MS, TWEEN_TICK_MS, worthAnimating } from './motionBudget';

describe('worthAnimating', () => {
  test('saut invisible (même texte ou un seul cran) → pas d\'animation', () => {
    expect(worthAnimating(10_000_000, 10_000_000, formatKB)).toBe(false);
    // 9,5 Go → 9,6 Go : l'animation n'afficherait aucune valeur intermédiaire
    expect(worthAnimating(9.5 * 1024 * 1024, 9.6 * 1024 * 1024, formatKB)).toBe(false);
    expect(worthAnimating(512 * 1024, 513 * 1024, formatKB)).toBe(false);
  });
  test('plusieurs crans affichés en chemin et variation ≥ 5 % → animation', () => {
    expect(worthAnimating(512 * 1024, 900 * 1024, formatKB)).toBe(true);
    expect(worthAnimating(9.0 * 1024 * 1024, 9.6 * 1024 * 1024, formatKB)).toBe(true);
    expect(worthAnimating(900 * 1024, 512 * 1024, formatKB)).toBe(true);
  });
  test('petite dérive (< 5 %) → saut, même si plusieurs crans s\'affichent', () => {
    expect(worthAnimating(512 * 1024, 520 * 1024, formatKB)).toBe(false);
    expect(worthAnimating(20.0 * 1024 * 1024, 20.4 * 1024 * 1024, formatKB)).toBe(false);
  });
});

describe('barWidth', () => {
  test('arrondi au pour-cent et borné : une variation infime ne relance pas la transition CSS', () => {
    expect(barWidth(65.12)).toBe('65%');
    expect(barWidth(65.48)).toBe('65%');
    expect(barWidth(65.6)).toBe('66%');
    expect(barWidth(-3)).toBe('0%');
    expect(barWidth(140)).toBe('100%');
    expect(barWidth(NaN)).toBe('0%');
  });
});

describe('tweenSteps', () => {
  test('quelques pas (20 i/s), départ adouci, arrivée exacte', () => {
    const s = tweenSteps(0, 100);
    expect(s).toHaveLength(Math.round(TWEEN_MS / TWEEN_TICK_MS));
    expect(s.at(-1)).toBe(100);
    expect(s.every((v, i) => i === 0 || v >= s[i - 1]!)).toBe(true);
    expect(s[0]!).toBeGreaterThan(100 / s.length); // ease-out : le premier pas est le plus grand
  });
  test('descente', () => {
    const s = tweenSteps(100, 40);
    expect(s.at(-1)).toBe(40);
    expect(s.every((v, i) => i === 0 || v <= s[i - 1]!)).toBe(true);
  });
});
