import { describe, expect, test } from 'vitest';
import { nowDelta, NOW_DELTA_TITLE } from './nowDelta';

const MB = 1024;
const GB = 1024 * 1024;

describe('écart « alors vs maintenant »', () => {
  test('mémoire : plus haut alors → « + », ton « higher » ; plus bas → « − », ton « lower »', () => {
    expect(nowDelta(7.866 * GB, 6.666 * GB, 'kb')).toEqual({ text: '+1,2 Go · +18 %', tone: 'higher', title: NOW_DELTA_TITLE });
    expect(nowDelta(3660 * MB, 4000 * MB, 'kb')).toEqual({ text: '−340 Mo · −9 %', tone: 'lower', title: NOW_DELTA_TITLE });
  });
  test('seuils : moins de 1 % ou moins de 10 Mo → rien', () => {
    expect(nowDelta(10 * GB + 50 * MB, 10 * GB, 'kb')).toBeNull(); // 50 Mo mais 0,5 %
    expect(nowDelta(109 * MB, 100 * MB, 'kb')).toBeNull(); // 9 % mais 9 Mo
    expect(nowDelta(110 * MB, 100 * MB, 'kb')?.text).toBe('+10 Mo · +10 %');
  });
  test('égalité : rien', () => {
    expect(nowDelta(5, 5, 'count')).toBeNull();
    expect(nowDelta(0, 0, 'kb')).toBeNull();
    expect(nowDelta(12, 12, 'cpu')).toBeNull();
  });
  test('processus : au moins 1 d\'écart, et 1 %', () => {
    expect(nowDelta(96, 109, 'count')?.text).toBe('−13 · −12 %');
    expect(nowDelta(3, 2, 'count')?.text).toBe('+1 · +50 %');
    expect(nowDelta(1000, 1005, 'count')).toBeNull(); // 0,5 %
  });
  test('CPU : écart en points, pas en %', () => {
    expect(nowDelta(50, 109, 'cpu')).toMatchObject({ text: '−59 pt', tone: 'lower' });
    expect(nowDelta(30.6, 12.2, 'cpu')).toMatchObject({ text: '+18 pt', tone: 'higher' });
    expect(nowDelta(10.4, 10, 'cpu')).toBeNull(); // < 1 pt
  });
  test('valeur actuelle nulle : écart absolu seul ; valeur manquante : rien', () => {
    expect(nowDelta(512 * MB, 0, 'kb')?.text).toBe('+512 Mo');
    expect(nowDelta(0, 300 * MB, 'kb')?.text).toBe('−300 Mo · −100 %');
    expect(nowDelta(null, 5, 'count')).toBeNull();
    expect(nowDelta(5, undefined, 'count')).toBeNull();
    expect(nowDelta(Number.NaN, 5, 'cpu')).toBeNull();
  });
  test('arrondi : le % affiché ne descend jamais à 0', () => {
    expect(nowDelta(101 * MB + 512, 100 * MB, 'kb')).toBeNull(); // 1,5 Mo
    expect(nowDelta(1.016 * GB, 1 * GB, 'kb')?.text).toBe('+16 Mo · +2 %');
  });
});
