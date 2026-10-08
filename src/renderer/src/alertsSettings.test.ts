import { expect, test } from 'vitest';
import { DEFAULT_CONFIG, validateConfig } from '../../core/config';
import { parseIntervalInput, SETTINGS_ALERT_TYPES, withChannel, withInterval } from './alertsSettings';

test('types réglables : ceux qui existent aujourd’hui (la prévision ② s’ajoutera ici)', () => {
  expect(SETTINGS_ALERT_TYPES.map((t) => t.type)).toEqual(['earlyoom_kill', 'leak', 'tmpfs', 'pressure']);
});

test('withChannel : change un seul type, config toujours valide', () => {
  const c = withChannel(DEFAULT_CONFIG, 'pressure', 'both');
  expect(c.alerts.channels.pressure).toBe('both');
  expect(c.alerts.channels.leak).toBe('both');
  expect(validateConfig(c)).toEqual(c);
});

test.each([
  ['5', 5], [' 120 ', 120], ['1', 1],
  ['0', 'Un entier entre 1 et 120 est attendu'], ['121', 'Un entier entre 1 et 120 est attendu'], ['2.5', 'Un entier entre 1 et 120 est attendu'],
  ['abc', 'Un entier entre 1 et 120 est attendu'], ['', 'Valeur requise'],
])('parseIntervalInput(%j) → %j', (raw, out) => {
  const r = parseIntervalInput(raw);
  if (typeof out === 'number') expect(r).toEqual({ value: out });
  else expect(r).toEqual({ error: out });
});

test('withInterval', () => {
  expect(withInterval(DEFAULT_CONFIG, 30).alerts.desktopMinIntervalMin).toBe(30);
});
