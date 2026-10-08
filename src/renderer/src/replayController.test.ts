import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ProcTreeAt } from '../../core/types';
import { ReplayController } from './replayController';

const T = 1_000_000;
const range = { from: T, to: T + 10 * 60_000 };
const treeAt = (ts: number): ProcTreeAt => ({ ts, source: 'detail', procs: [], recorded: true, omitted: 0 });

/** fetch simulé : chaque appel reste en attente jusqu'à resolve(i). */
function setup(live = { v: true }) {
  const calls: { key: string; ts: number; resolve: (t: ProcTreeAt | null) => void }[] = [];
  const fetch = vi.fn((key: string, ts: number) => new Promise<ProcTreeAt | null>((resolve) => calls.push({ key, ts, resolve })));
  const onChange = vi.fn();
  const c = new ReplayController('g', { fetch, isLive: () => live.v, onChange });
  return { c, calls, fetch, onChange, live };
}
const flush = () => Promise.resolve().then(() => Promise.resolve());

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('une requête à la fois : le tick est sauté tant que la précédente n\'est pas revenue', async () => {
  const { c, calls } = setup();
  c.play(range);
  expect(calls.map((x) => x.ts)).toEqual([T]);
  vi.advanceTimersByTime(3000);
  expect(calls).toHaveLength(1);
  expect(c.state.instant).toBe(T);
  calls[0].resolve(treeAt(T));
  await flush();
  vi.advanceTimersByTime(1000);
  expect(calls.map((x) => x.ts)).toEqual([T, T + 60_000]);
});

test('réponses périmées ignorées : seul l\'arbre du dernier instant demandé est gardé', async () => {
  const { c, calls } = setup();
  c.pick(T);
  c.pick(T + 5000);
  calls[1].resolve(treeAt(T + 5000));
  calls[0].resolve(treeAt(T));
  await flush();
  expect(c.tree?.ts).toBe(T + 5000);
});

test('fenêtre réduite ou cachée : la lecture n\'avance plus, et reprend à la restauration', async () => {
  const { c, calls, live } = setup();
  c.play(range);
  calls[0].resolve(treeAt(T));
  await flush();
  live.v = false;
  vi.advanceTimersByTime(5000);
  expect(c.state.instant).toBe(T);
  expect(calls).toHaveLength(1);
  live.v = true;
  vi.advanceTimersByTime(1000);
  expect(c.state.instant).toBe(T + 60_000);
});

test('minuterie nettoyée : pause, fin de plage, live, dispose', async () => {
  const { c, calls } = setup();
  c.play(range);
  expect(vi.getTimerCount()).toBe(1);
  c.pause();
  expect(vi.getTimerCount()).toBe(0);
  c.play({ from: T, to: T + 60_000 });
  calls.at(-1)!.resolve(treeAt(T));
  await flush();
  vi.advanceTimersByTime(1000); // atteint la fin
  expect(c.state).toMatchObject({ instant: T + 60_000, playing: false });
  expect(vi.getTimerCount()).toBe(0);
  c.play(range);
  c.live();
  expect(vi.getTimerCount()).toBe(0);
  expect(c.tree).toBeUndefined();
  c.play(range);
  c.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

test('changement de groupe : retour au direct immédiat, requête en cours abandonnée', async () => {
  const { c, calls, onChange } = setup();
  c.pick(T);
  onChange.mockClear();
  expect(c.setGroup('g')).toBe(false);
  expect(c.setGroup('h')).toBe(true);
  expect(c.state).toEqual({ instant: null, playing: false, range: null });
  calls[0].resolve(treeAt(T));
  await flush();
  expect(c.tree).toBeUndefined();
  expect(onChange).not.toHaveBeenCalled(); // appelé pendant le rendu : pas de notification
  c.pick(T + 1);
  expect(calls.at(-1)).toMatchObject({ key: 'h', ts: T + 1 });
});

test('échec de la requête : historique indisponible (null)', async () => {
  const { c } = setup();
  const failing = new ReplayController('g', { fetch: () => Promise.reject(new Error('x')), isLive: () => true, onChange: () => {} });
  failing.pick(T);
  await flush();
  expect(failing.tree).toBeNull();
  c.dispose();
});
