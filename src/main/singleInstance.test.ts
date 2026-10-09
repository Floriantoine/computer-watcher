import { expect, test } from 'vitest';
import { acquireLock } from './singleInstance';

const tries = (results: boolean[]) => {
  let n = 0;
  return { tryLock: () => results[Math.min(n++, results.length - 1)], count: () => n };
};

test('verrou obtenu tout de suite', () => {
  const t = tries([true]);
  expect(acquireLock({ tryLock: t.tryLock, env: {}, sleep: () => {} })).toBe(true);
  expect(t.count()).toBe(1);
});

test('lancement ordinaire refusé : pas de nouvel essai (l’instance ouverte est affichée)', () => {
  const t = tries([false]);
  const slept: number[] = [];
  expect(acquireLock({ tryLock: t.tryLock, env: {}, sleep: (ms) => slept.push(ms) })).toBe(false);
  expect(t.count()).toBe(1);
  expect(slept).toEqual([]);
});

test('relance après une mise à jour (APPIMAGE_SILENT_INSTALL) : réessaie le temps que l’ancienne version quitte', () => {
  const t = tries([false, false, false, true]);
  const slept: number[] = [];
  expect(acquireLock({ tryLock: t.tryLock, env: { APPIMAGE_SILENT_INSTALL: 'true' }, sleep: (ms) => slept.push(ms) })).toBe(true);
  expect(slept).toEqual([250, 250, 250]);
});

test('relance après une mise à jour : abandon après ~5 s', () => {
  const t = tries([false]);
  const slept: number[] = [];
  expect(acquireLock({ tryLock: t.tryLock, env: { APPIMAGE_SILENT_INSTALL: 'true' }, sleep: (ms) => slept.push(ms) })).toBe(false);
  expect(slept.reduce((a, b) => a + b, 0)).toBe(5000);
});
