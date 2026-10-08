import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { SNOOZE_MS } from './forecast';
import { readSnooze, writeSnooze } from './snooze';

const dir = () => mkdtempSync(join(tmpdir(), 'pw-snooze-'));

test('readSnooze : borné à maintenant + 30 min (fichier corrompu, horloge faussée)', () => {
  const p = join(dir(), 's.json');
  const now = 1_000_000;
  writeSnooze(p, now + 10 * 60_000);
  expect(readSnooze(p, now)).toBe(now + 10 * 60_000);
  writeSnooze(p, 4_102_444_800_000); // 2100
  expect(readSnooze(p, now)).toBe(now + SNOOZE_MS);
});

test.each([
  ['{"snoozedUntil":"demain"}'], ['{"snoozedUntil":-5}'], ['{"snoozedUntil":null}'], ['pas du json'], ['[]'], ['{"snoozedUntil":1e400}'],
])('readSnooze : valeur invalide ignorée : %s', (text) => {
  const p = join(dir(), 's.json');
  writeFileSync(p, text);
  expect(readSnooze(p, 1000)).toBeNull();
});

test('readSnooze : fichier absent → null', () => {
  expect(readSnooze(join(dir(), 'nope.json'), 1000)).toBeNull();
});
