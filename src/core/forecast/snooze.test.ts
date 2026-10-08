import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { SNOOZE_MS } from './forecast';
import { readSnooze, writeSnooze } from './snooze';

const dir = () => mkdtempSync(join(tmpdir(), 'pw-snooze-'));

test('readSnooze : la pause vaut au plus 30 min après la demande (setAt), jamais prolongée par une relecture', () => {
  const p = join(dir(), 's.json');
  const now = 1_000_000;
  writeSnooze(p, now + 10 * 60_000, now);
  expect(readSnooze(p, now)).toBe(now + 10 * 60_000);
  expect(readSnooze(p, now + 5 * 60_000)).toBe(now + 10 * 60_000);
});

test('readSnooze : un fichier qui dépasse setAt + 30 min est refusé, et la relecture ne prolonge pas la pause', () => {
  const p = join(dir(), 's.json');
  const now = 1_000_000;
  writeSnooze(p, 4_102_444_800_000, now); // 2100
  expect(readSnooze(p, now)).toBeNull();
  // ancien format sans setAt : refusé (sinon chaque relecture repoussait la fin de 30 min)
  writeFileSync(p, JSON.stringify({ snoozedUntil: 4_102_444_800_000 }));
  expect(readSnooze(p, now)).toBeNull();
  expect(readSnooze(p, now + 60 * 60_000)).toBeNull();
});

test('readSnooze : une demande datée du futur (horloge faussée, fichier forgé) est refusée', () => {
  const p = join(dir(), 's.json');
  const now = 1_000_000;
  writeSnooze(p, now + 2 * SNOOZE_MS, now + SNOOZE_MS);
  expect(readSnooze(p, now)).toBeNull();
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
