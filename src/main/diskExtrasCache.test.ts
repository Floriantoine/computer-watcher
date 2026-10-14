import { describe, expect, test } from 'vitest';
import { createExtrasCache } from './diskExtrasCache';

/** Analyse factice : chaque appel renvoie une promesse résolue à la main. */
function scripted() {
  const pending: { resolve: (v: { view: { at: number; n: number }; state: string }) => void; reject: (e: Error) => void }[] = [];
  let n = 0;
  const load = () => new Promise<{ view: { at: number; n: number }; state: string }>((resolve, reject) => pending.push({ resolve, reject }));
  const finish = (i: number) => pending[i].resolve({ view: { at: 0, n: ++n }, state: `état ${n}` });
  return { load, pending, finish };
}

describe('createExtrasCache', () => {
  test('analyse récente gardée ; force relance ; appels simultanés partagés', async () => {
    const s = scripted();
    const c = createExtrasCache(s.load, { maxAgeMs: 1000, now: () => 0 });
    const a = c.get(false);
    const b = c.get(true);
    expect(s.pending).toHaveLength(1);
    s.finish(0);
    expect((await a).n).toBe(1);
    expect(await b).toEqual(await a);
    expect(c.state()).toBe('état 1');
    expect((await c.get(false)).n).toBe(1);
    expect(s.pending).toHaveLength(1);
    const f = c.get(true);
    s.finish(1);
    expect((await f).n).toBe(2);
  });
  test('ménage pendant une analyse : l’ancienne analyse n’écrase pas l’état, un nouvel appel relance', async () => {
    const s = scripted();
    const c = createExtrasCache(s.load, { maxAgeMs: 1000, now: () => 0 });
    const old = c.get(true);
    c.invalidate();
    expect(c.state()).toBeNull();
    const fresh = c.get(true);
    expect(s.pending).toHaveLength(2);
    s.finish(0); // l'ancienne analyse se termine après le ménage
    await old;
    expect(c.state()).toBeNull();
    s.finish(1);
    expect((await fresh).n).toBe(2);
    expect(c.state()).toBe('état 2');
  });
  test('la fin de l’ancienne analyse ne libère pas la nouvelle en cours', async () => {
    const s = scripted();
    const c = createExtrasCache(s.load, { maxAgeMs: 1000, now: () => 0 });
    const old = c.get(true);
    c.invalidate();
    const fresh = c.get(true);
    s.finish(0);
    await old;
    const again = c.get(true); // doit partager la nouvelle analyse, pas en lancer une troisième
    expect(s.pending).toHaveLength(2);
    s.finish(1);
    expect(await again).toEqual(await fresh);
  });
  test('analyse en échec : rien gardé, l’appel suivant relance', async () => {
    const s = scripted();
    const c = createExtrasCache(s.load, { maxAgeMs: 1000, now: () => 0 });
    const a = c.get(false);
    s.pending[0].reject(new Error('panne'));
    await expect(a).rejects.toThrow('panne');
    expect(c.state()).toBeNull();
    c.get(false);
    expect(s.pending).toHaveLength(2);
  });
  test('analyse trop vieille (ou horloge reculée) : relancée', async () => {
    const s = scripted();
    let t = 0;
    const c = createExtrasCache(s.load, { maxAgeMs: 1000, now: () => t });
    const a = c.get(false);
    s.finish(0);
    await a;
    t = 1000;
    c.get(false);
    expect(s.pending).toHaveLength(2);
  });
});
