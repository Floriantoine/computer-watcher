import { expect, test } from 'vitest';
import { createFreeOpener, wantsFree } from './launchArgs';

test('wantsFree : --free exact seulement', () => {
  expect(wantsFree(['/x/proc-watch', '--free'])).toBe(true);
  expect(wantsFree(['--freeze'])).toBe(false);
  expect(wantsFree([])).toBe(false);
});

test('createFreeOpener : envoie tout de suite et garde la demande jusqu’à ce que le renderer la prenne', () => {
  const sent: number[] = [];
  const o = createFreeOpener(() => sent.push(1));
  expect(o.take()).toBe(false);
  o.open();
  expect(sent).toHaveLength(1);
  expect(o.take()).toBe(true);
  expect(o.take()).toBe(false);
});
