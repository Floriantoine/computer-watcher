// src/core/history/leak.test.ts
import { expect, test } from 'vitest';
import { detectLeak } from './leak';

const ramp = (n: number, step: number, start = 1000) => Array.from({ length: n }, (_, i) => start + i * step);

test('montée régulière de 61 points × 10 Mo → fuite', () => {
  expect(detectLeak(ramp(61, 10 * 1024), 60, 300 * 1024)).toEqual({ leak: true, growthKB: 600 * 1024 });
});

test('montée trop faible → pas de fuite', () => {
  expect(detectLeak(ramp(61, 1024), 60, 300 * 1024).leak).toBe(false);
});

test('escalier (hausse 1 minute sur 3) → pas de fuite malgré la croissance', () => {
  const s = Array.from({ length: 61 }, (_, i) => 1000 + Math.floor(i / 3) * 50 * 1024);
  expect(detectLeak(s, 60, 300 * 1024).leak).toBe(false);
});

test('oscillation → pas de fuite', () => {
  const s = Array.from({ length: 61 }, (_, i) => 1000 + (i % 2) * 500 * 1024);
  expect(detectLeak(s, 60, 300 * 1024).leak).toBe(false);
});

test('pic isolé à la fin → pas de fuite', () => {
  const s = [...Array(60).fill(1000), 1000 + 900 * 1024];
  expect(detectLeak(s, 60, 300 * 1024).leak).toBe(false);
});

test('série trop courte → pas de fuite', () => {
  expect(detectLeak(ramp(30, 50 * 1024), 60, 300 * 1024).leak).toBe(false);
});

test('ne regarde que la fenêtre la plus récente', () => {
  const s = [...Array(100).fill(5_000_000), ...ramp(61, 10 * 1024)];
  expect(detectLeak(s, 60, 300 * 1024).leak).toBe(true);
});
