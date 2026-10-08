import { expect, test } from 'vitest';
import { createFreeOpener, wantsFree } from './launchArgs';

test('wantsFree : --free exact seulement', () => {
  expect(wantsFree(['/x/proc-watch', '--free'])).toBe(true);
  expect(wantsFree(['--freeze'])).toBe(false);
  expect(wantsFree([])).toBe(false);
});

test('createFreeOpener : envoi différé et protégé, demande gardée jusqu’à ce que le renderer la prenne', async () => {
  const sent: number[] = [];
  const o = createFreeOpener(() => {
    sent.push(1);
    throw new ReferenceError("Cannot access 'mainWin' before initialization");
  });
  expect(o.take()).toBe(false);
  expect(() => o.open()).not.toThrow();
  expect(sent).toHaveLength(0); // jamais synchrone (démarrage à froid)
  await Promise.resolve();
  expect(sent).toHaveLength(1);
  expect(o.take()).toBe(true);
  expect(o.take()).toBe(false);
});
