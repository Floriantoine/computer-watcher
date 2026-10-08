import { describe, expect, it } from 'vitest';
import type { ListenSocket } from '../core/collector/ports';
import { PortSweep, type PortSweepDeps } from './portSweep';

/** Faux environnement : minuteries en file (exécutées à la main), lecteurs comptés. */
function harness(pids = [1, 2, 3, 4, 5]) {
  const queue: { fn: () => void; ms: number; id: number }[] = [];
  let id = 0;
  let t = 0;
  const calls = { sockets: 0, slices: [] as number[], done: 0 };
  const sockets: ListenSocket[] = [{ inode: 1, port: 3000, uid: 1000 }, { inode: 2, port: 3000, uid: 1000 }];
  const deps: PortSweepDeps = {
    readSockets: () => {
      calls.sockets++;
      return sockets;
    },
    // 2 pids par tranche ; le pid n écoute le port 3000 + n
    readSlice: (list, start) => {
      calls.slices.push(start);
      const next = Math.min(start + 2, list.length);
      // le pid 4 a trop de fd pour une tranche
      return { ports: new Map(list.slice(start, next).filter((p) => p !== 4).map((p) => [p, [3000 + p]])), next, tooBig: list.slice(start, next).filter((p) => p === 4) };
    },
    pids: () => pids,
    schedule: (fn, ms) => {
      queue.push({ fn, ms, id: ++id });
      return id;
    },
    cancel: (h) => {
      const i = queue.findIndex((q) => q.id === h);
      if (i >= 0) queue.splice(i, 1);
    },
    now: () => t,
    onDone: () => calls.done++,
  };
  const sweep = new PortSweep(deps, { everyMs: 10_000, maxFds: 2000, gapMs: 20 });
  const runAll = () => {
    while (queue.length) queue.shift()!.fn();
  };
  return { sweep, queue, calls, runAll, setNow: (n: number) => (t = n) };
}

describe('PortSweep', () => {
  it('hors du mode : aucune lecture', () => {
    const h = harness();
    h.sweep.tick();
    expect(h.queue).toHaveLength(0);
    expect(h.sweep.listen).toBeUndefined();
  });

  it('entrée dans le mode : passe planifiée tout de suite, jamais synchrone', () => {
    const h = harness();
    h.sweep.setMode(true);
    expect(h.calls.sockets).toBe(0);
    expect(h.calls.slices).toEqual([]);
    expect(h.queue.map((q) => q.ms)).toEqual([0]);
  });

  it('passe découpée en tranches espacées, résultat publié une fois complet', () => {
    const h = harness();
    h.sweep.setMode(true);
    h.queue.shift()!.fn();
    expect(h.calls.slices).toEqual([0]);
    expect(h.sweep.listen).toBeUndefined();
    expect(h.queue.map((q) => q.ms)).toEqual([20]);
    h.runAll();
    expect(h.calls.slices).toEqual([0, 2, 4]);
    expect(h.calls.sockets).toBe(1);
    expect(h.calls.done).toBe(1);
    expect(h.sweep.listen!.byPid.get(5)).toEqual([3005]);
    expect(h.sweep.listen!.byPid.size).toBe(4);
    expect(h.sweep.listen!.tooBig).toBe(1);
    // sockets dédoublonnés par (port, uid)
    expect(h.sweep.listen!.sockets).toHaveLength(1);
  });

  it('cadence : nouvelle passe seulement 10 s après la précédente ; pas deux passes à la fois', () => {
    const h = harness();
    h.sweep.setMode(true);
    h.sweep.tick();
    expect(h.queue).toHaveLength(1);
    h.runAll();
    h.setNow(9_999);
    h.sweep.tick();
    expect(h.queue).toHaveLength(0);
    h.setNow(10_000);
    h.sweep.tick();
    expect(h.queue).toHaveLength(1);
    h.runAll();
    expect(h.calls.done).toBe(2);
  });

  it('sortie du mode : passe en cours annulée, liste effacée ; ré-entrée : relecture immédiate', () => {
    const h = harness();
    h.sweep.setMode(true);
    h.runAll();
    expect(h.sweep.listen).toBeDefined();
    h.setNow(1000);
    h.sweep.tick(); // trop tôt : rien
    h.sweep.setMode(false);
    expect(h.sweep.listen).toBeUndefined();
    h.sweep.setMode(true);
    h.queue.shift()!.fn();
    h.sweep.setMode(false);
    expect(h.queue).toHaveLength(0);
    const before = h.calls.slices.length;
    h.sweep.setMode(true);
    h.runAll();
    expect(h.calls.slices.length).toBe(before + 3);
    expect(h.calls.slices.slice(-3)).toEqual([0, 2, 4]);
  });

  it('setMode identique : sans effet', () => {
    const h = harness();
    h.sweep.setMode(true);
    h.sweep.setMode(true);
    expect(h.queue).toHaveLength(1);
  });
});
