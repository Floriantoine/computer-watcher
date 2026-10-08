import { expect, test } from 'vitest';
import { formatAxisTime, formatKBAxis, formatTipTime, rgba, toneColors } from './uplotTheme';

const t = (d: number, h: number, m: number, s = 0) => new Date(2026, 9, d, h, m, s).getTime();
const H = 3600_000;

test('axe du temps : HH:mm si la plage tient en 24 h', () => {
  expect(formatAxisTime(t(7, 9, 5), 24 * H)).toBe('09:05');
});
test('axe du temps : dd/MM HH:mm au-delà de 24 h', () => {
  expect(formatAxisTime(t(3, 14, 0), 7 * 24 * H)).toBe('03/10 14:00');
});
test('axe du temps : secondes quand le pas des graduations est sous la minute (pas de libellé répété)', () => {
  const ticks = [t(7, 12, 14, 0), t(7, 12, 14, 10), t(7, 12, 14, 20)];
  const labels = ticks.map((v) => formatAxisTime(v, 40_000, 10_000));
  expect(labels).toEqual(['12:14:00', '12:14:10', '12:14:20']);
  expect(new Set(labels).size).toBe(labels.length);
  expect(formatAxisTime(t(7, 9, 5), H, 60_000)).toBe('09:05');
  expect(formatAxisTime(t(3, 14, 0, 30), 7 * 24 * H, 30_000)).toBe('03/10 14:00:30');
});
test('info-bulle : secondes sur une plage courte, date sinon', () => {
  expect(formatTipTime(t(7, 9, 5, 7), H)).toBe('09:05:07');
  expect(formatTipTime(t(7, 9, 5, 7), 30 * 24 * H)).toBe('07/10 09:05');
});
test('axe Ko : unités françaises sans décimale inutile', () => {
  expect(formatKBAxis(0)).toBe('0');
  expect(formatKBAxis(512)).toBe('512 Ko');
  expect(formatKBAxis(256 * 1024)).toBe('256 Mo');
  expect(formatKBAxis(2 * 1024 * 1024)).toBe('2 Go');
  expect(formatKBAxis(1.5 * 1024 * 1024)).toBe('1,5 Go');
});
test('rgba depuis un hex', () => {
  expect(rgba('#7c5cff', 0.5)).toBe('rgba(124,92,255,0.5)');
});
test('teintes : jeu nommé ou couleur brute', () => {
  expect(toneColors('mem')).toEqual({ fill: '#7c5cff', line: '#b56bff' });
  expect(toneColors('#123456')).toEqual({ fill: '#123456', line: '#123456' });
});
