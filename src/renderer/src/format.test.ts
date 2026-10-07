import { expect, test } from 'vitest';
import { formatAge, formatCpu, formatKB } from './format';

test('formatKB', () => {
  expect(formatKB(0)).toBe('0 Ko');
  expect(formatKB(512)).toBe('512 Ko');
  expect(formatKB(2048)).toBe('2 Mo');
  expect(formatKB(11_114_906)).toBe('10,6 Go');
});

test('formatAge', () => {
  expect(formatAge(51.7)).toBe('51 s');
  expect(formatAge(300)).toBe('5 min');
  expect(formatAge(7200)).toBe('2 h');
  expect(formatAge(7 * 86400 + 5)).toBe('7 j');
});

test('formatCpu', () => {
  expect(formatCpu(99.6)).toBe('100 %');
});
