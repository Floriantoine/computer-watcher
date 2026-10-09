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

test('verrou obtenu : APPIMAGE_SILENT_INSTALL retiré de l’environnement (pas transmis aux processus lancés ensuite)', () => {
  const env: NodeJS.ProcessEnv = { APPIMAGE_SILENT_INSTALL: 'true', HOME: '/home/u' };
  const t = tries([false, true]);
  expect(acquireLock({ tryLock: t.tryLock, env, sleep: () => {} })).toBe(true);
  expect(env).toEqual({ HOME: '/home/u' });
  const env2: NodeJS.ProcessEnv = { APPIMAGE_SILENT_INSTALL: 'true' };
  expect(acquireLock({ tryLock: () => true, env: env2, sleep: () => {} })).toBe(true);
  expect('APPIMAGE_SILENT_INSTALL' in env2).toBe(false);
});

test('n-3 : relance par proc-watch (PROC_WATCH_RELAUNCH=1) : réessaie aussi, et la variable est retirée', () => {
  const env: NodeJS.ProcessEnv = { PROC_WATCH_RELAUNCH: '1', HOME: '/home/u' };
  const t = tries([false, false, true]);
  const slept: number[] = [];
  expect(acquireLock({ tryLock: t.tryLock, env, sleep: (ms) => slept.push(ms) })).toBe(true);
  expect(slept).toEqual([250, 250]);
  expect(env).toEqual({ HOME: '/home/u' });
});

test('n-3 : autre valeur que « 1 » : pas de nouvel essai', () => {
  const t = tries([false]);
  expect(acquireLock({ tryLock: t.tryLock, env: { PROC_WATCH_RELAUNCH: 'oui' }, sleep: () => {} })).toBe(false);
  expect(t.count()).toBe(1);
});
