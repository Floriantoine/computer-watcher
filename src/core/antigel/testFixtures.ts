// Données et faux client systemd pour les tests (service, main, renderer). Noms neutres ; aucun busctl.
import type { CgroupStats } from './cgroupfs';
import type { AntigelState } from './state';
import { BusctlError, setProjectHighArgv, setSliceArgv, startProjectSliceArgv, startScopeArgv, startSliceArgv, type SystemdClient } from './systemd';
import { scopePath, slicePath } from './units';

export const sampleState = (o: Partial<AntigelState> = {}): AntigelState => ({
  version: 1, at: 1_000_000, enabled: true, status: 'active', reason: null, memTotalKB: 16 * 1024 * 1024, reserveKB: 4 * 1024 * 1024,
  slice: { currentKB: 2 * 1024 * 1024, highKB: 12 * 1024 * 1024, maxKB: 14 * 1024 * 1024, swapMaxKB: 4 * 1024 * 1024, throttles: 3, oomKills: 0 },
  projects: [{ unit: 'cwatch-p-alpha.slice', root: '/home/u/alpha', procs: 3, currentKB: 1024 * 1024, budgetMB: null, throttled: false }],
  slices: { 'cwatch-p-alpha.slice': '/home/u/alpha', 'cwatch-p-autres.slice': null }, lastError: null, tickMs: 0.4, dbusCalls: 2, ...o,
});

/** Statistiques de cgroup d'exemple (1 Gio, sans plafond, aucun événement). */
export const sampleStats = (o: Partial<CgroupStats> = {}): CgroupStats => ({
  currentBytes: 1024 ** 3, highBytes: null, maxBytes: null, swapMaxBytes: null, events: { high: 0, max: 0, oom: 0, oomKill: 0 }, populated: true, ...o,
});

export interface FakeSystemd {
  client: SystemdClient;
  /** Appels reçus (nom de la méthode puis arguments) ; les tests peuvent le vider. */
  calls: unknown[][];
  /** Faux /sys/fs/cgroup : chemin de cgroup → statistiques. */
  sys: Map<string, CgroupStats>;
  /** Faux /proc/<pid>/cgroup des processus déplacés. */
  cg: Map<number, string>;
}

/**
 * Faux client systemd (aucun busctl) : chaque appel valide son argv avec les vrais constructeurs de systemd.ts (un nom
 * refusé lève comme en production), puis simule son effet sur `sys` et `cg`. SetUnitProperties sur une slice de projet
 * inconnue échoue en « no-unit », StartTransientUnit d'un scope déjà connu en « exists », comme le vrai systemd.
 */
export function fakeSystemd(o: {
  userBase: string;
  fail?: (method: string, args: readonly unknown[]) => BusctlError | null;
  /** Les appels ne finissent jamais (gestionnaire saturé). */
  hang?: () => boolean;
}): FakeSystemd {
  const calls: unknown[][] = [];
  const sys = new Map<string, CgroupStats>();
  const cg = new Map<number, string>();
  const started = new Set<string>();
  let n = 0;
  const path = (slice: string) => `${o.userBase}/${slicePath(slice)}`;
  const put = (p: string, s: Partial<CgroupStats>) => sys.set(p, { ...(sys.get(p) ?? sampleStats({ currentBytes: 0 })), ...s });
  const act = async (name: string, args: unknown[], argv: () => string[], effect: () => void) => {
    argv();
    n++;
    calls.push([name, ...args]);
    if (o.hang?.()) return new Promise<void>(() => {});
    const err = o.fail?.(name, args);
    if (err) throw err;
    effect();
  };
  const client: SystemdClient = {
    ensureSlice: (s, l) =>
      act('ensureSlice', [s, l.highBytes, l.maxBytes, l.swapMaxBytes], () => startSliceArgv(s, l), () =>
        put(path(s), { highBytes: l.highBytes, maxBytes: l.maxBytes, swapMaxBytes: l.swapMaxBytes })),
    setSlice: (s, l) =>
      act('setSlice', [s, l ? l.highBytes : null], () => setSliceArgv(s, l), () =>
        put(path(s), { highBytes: l ? l.highBytes : null, maxBytes: l ? l.maxBytes : null, swapMaxBytes: l ? l.swapMaxBytes : null })),
    // une slice de projet neuve est vide ; un scope la peuple
    ensureProjectSlice: (s, h) =>
      act('ensureProjectSlice', [s, h], () => startProjectSliceArgv(s, h), () => put(path(s), { highBytes: h, populated: sys.get(path(s))?.populated ?? false })),
    setProjectHigh: (s, h) =>
      act('setProjectHigh', [s, h], () => setProjectHighArgv(s, h), () => {
        if (!sys.has(path(s))) throw new BusctlError(`Unit ${s} not loaded.`, 'no-unit');
        put(path(s), { highBytes: h });
      }),
    startScope: (scope, s, pids) =>
      act('startScope', [scope, s, [...pids]], () => startScopeArgv(scope, s, pids), () => {
        if (started.has(scope)) throw new BusctlError(`Unit ${scope} was already loaded or has a fragment file.`, 'exists');
        started.add(scope);
        put(path(s), { populated: true });
        for (const pid of pids) cg.set(pid, `${o.userBase}/${scopePath(scope, s)}`);
      }),
    stopTestUnit: async () => {
      throw new Error('jamais appelé par le service');
    },
    calls: () => n,
  };
  return { client, calls, sys, cg };
}
