// Orchestrateur anti-gel : faux client systemd (testFixtures, aucun busctl), faux sysfs et faux cgroups. Noms neutres.
import { describe, expect, test, vi } from 'vitest';
import { buildGroups } from '../grouping/buildGroups';
import type { ProcInfo, SystemInfo } from '../types';
import type { Availability, CgroupStats } from './cgroupfs';
import type { AntigelConfig } from './config';
import { BUDGET_RETRY_MS, PROBE_EVERY_MS, RECHECK_YOUNG_MS, THROTTLE_HOLD_MS, createAntigel, type AntigelDeps } from './controller';
import { GiB } from './limits';
import { BusctlError, MAX_PIDS } from './systemd';
import { fakeSystemd, sampleStats as stats } from './testFixtures';
import { shortHash } from './units';

const BASE = '/user.slice/user-1000.slice/user@1000.service';
const WARP = `${BASE}/app.slice/app-dev.warp.Warp@1.service`;
const ROOT = `${BASE}/cwatch.slice`;
const PS = 'cwatch-p-alpha.slice';
const PSCG = `${ROOT}/cwatch-p.slice/${PS}`;
const SCOPE = /^cwatch-p-alpha-[a-z0-9]{1,12}\.scope$/;
const A = '/home/u/alpha';
const NM = `${A}/node_modules`;
const ON: AntigelConfig = { enabled: true, reserveMB: null, budgets: {} };
const OFF: AntigelConfig = { ...ON, enabled: false };
// RAM entièrement disponible : le plafond dynamique vaut le plafond statique (12 Go), sauf dans les tests qui le font varier.
const SYS: SystemInfo = { memTotalKB: 16 * 1024 * 1024, memAvailableKB: 16 * 1024 * 1024, swapTotalKB: 8 * 1024 * 1024, swapFreeKB: 8 * 1024 * 1024, load1: 1, psiSome10: null, shmemKB: null };
const ROOT_CALL = ['ensureSlice', 'cwatch.slice', 12 * GiB, 14 * GiB, 4 * GiB];
const ev = (o: Partial<CgroupStats['events']> = {}) => ({ high: 0, max: 0, oom: 0, oomKill: 0, ...o });

let stc = 1;
const p = (pid: number, ppid: number, name: string, cmdline: string, cwd: string | null = null): ProcInfo => ({
  pid, ppid, name, cmdline, uid: 1000, startTicks: stc++, ageSec: 10, cpuTicks: 0, cpuPercent: 0, rssKB: 100_000, swapKB: 0, cwd, cwdDeleted: false,
});
const world = () => [
  p(600, 500, 'warp', 'warp'), p(601, 600, 'zsh', 'zsh', A),
  p(700, 601, 'npm run test', 'npm run test', A), p(701, 700, 'sh', 'sh -c jest', A),
  p(702, 701, 'MainThread', `node ${NM}/jest/bin/jest.js`, A),
  p(703, 702, 'MainThread', `node ${NM}/jest-worker/build/workers/processChild.js`, A),
  p(704, 702, 'MainThread', `node ${NM}/jest-worker/build/workers/processChild.js`, A),
];
const vitest = (pid: number) => p(pid, 601, 'MainThread', `node ${NM}/vitest/vitest.mjs run`, A);

function harness(o: {
  avail?: Availability; reverify?: AntigelDeps['reverify']; fail?: (method: string, args: readonly unknown[]) => BusctlError | null;
  hang?: boolean; initialSlices?: Record<string, string | null>; roots?: Record<string, string>; workMemo?: Map<string, boolean>;
} = {}) {
  const fake = fakeSystemd({ userBase: BASE, fail: o.fail, hang: () => !!o.hang });
  const logs: string[] = [];
  let mono = 0;
  const probe = vi.fn(() => o.avail ?? ({ ok: true, userBase: BASE, busctl: '/usr/bin/busctl' } as Availability));
  const reverify = vi.fn(o.reverify ?? ((t) => [...t]));
  const ag = createAntigel({
    client: fake.client, probe, reverify, log: (m) => logs.push(m), monoNow: () => mono, perfNow: () => 0, initialSlices: o.initialSlices, workMemo: o.workMemo,
    stats: (path) => fake.sys.get(path) ?? null, cgroupOf: (pid) => fake.cg.get(pid) ?? WARP,
  });
  const rootOf = (c: string) => Object.entries({ [A]: A, ...o.roots }).find(([k]) => c === k || c.startsWith(`${k}/`))?.[1] ?? null;
  let procs = world();
  let system = SYS;
  let claudeDirs: string[] | undefined;
  const input = (config: AntigelConfig) => ({
    ts: 1_000_000 + mono, procs, system, config, currentUid: 1000, selfPid: 900, appRoot: null, home: '/home/u', claudeDirs,
    isProtected: (n: string) => ['zsh', 'warp'].includes(n),
    groups: buildGroups(procs, { home: '/home/u', currentUid: 1000, isProtected: () => false, othersThreshold: { memMB: 0, cpuPercent: 0 }, projectRootOf: rootOf }),
  });
  const step = async (config: AntigelConfig = ON, ms = 5000) => {
    mono += ms;
    const out = ag.tick(input(config));
    await ag.idle();
    return out;
  };
  return {
    ag, calls: fake.calls, cg: fake.cg, sys: fake.sys, logs, probe, reverify, step, input,
    setProcs: (x: ProcInfo[]) => { procs = x; },
    setSystem: (o: Partial<SystemInfo>) => { system = { ...SYS, ...o }; },
    setClaudeDirs: (d: string[]) => { claudeDirs = d; },
  };
}
const names = (calls: unknown[][]) => calls.map((c) => c[0]);

describe('orchestrateur anti-gel', () => {
  test('premier tick : cwatch.slice plafonnée, puis slice du projet, puis un scope neuf (npm et tout son sous-arbre) ; ensuite aucun appel', async () => {
    const h = harness();
    await h.step();
    expect(h.calls).toEqual([
      ROOT_CALL,
      ['ensureProjectSlice', PS, null],
      ['startScope', expect.stringMatching(SCOPE), PS, [700, 701, 702, 703, 704]],
    ]);
    expect(h.reverify).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ pid: 700 })]), WARP);
    expect(h.cg.get(704)).toMatch(new RegExp(`^${PSCG}/cwatch-p-alpha-[a-z0-9]+\\.scope$`));
    h.calls.length = 0;
    for (let k = 0; k < 5; k++) await h.step();
    expect(h.calls).toEqual([]);
    expect(h.ag.state()).toMatchObject({
      status: 'active', enabled: true, reserveKB: 4 * 1024 * 1024, dbusCalls: 3, lastError: null,
      projects: [{ unit: PS, root: A, procs: 5, budgetMB: null, throttled: false }], slices: { [PS]: A },
    });
  });

  test('PID recyclé ou disparu avant l’appel (revérification vide) : ni slice de projet ni scope', async () => {
    const h = harness({ reverify: () => [] });
    await h.step();
    expect(names(h.calls)).toEqual(['ensureSlice']);
  });

  test('revérification juste avant le scope : seuls les PIDs encore valides partent', async () => {
    const h = harness({ reverify: (t) => t.filter((x) => x.pid !== 703) });
    await h.step();
    expect(h.calls.at(-1)).toEqual(['startScope', expect.stringMatching(SCOPE), PS, [700, 701, 702, 704]]);
  });

  test('deux lots successifs d’un même projet : deux scopes distincts dans la même slice, slice assurée une seule fois', async () => {
    const h = harness();
    await h.step();
    const first = h.calls.at(-1)![1];
    h.calls.length = 0;
    h.setProcs([...world(), vitest(720)]);
    await h.step();
    expect(h.calls).toEqual([['startScope', expect.stringMatching(SCOPE), PS, [720]]]);
    expect(h.calls[0]![1]).not.toBe(first);
    h.calls.length = 0;
    await h.step();
    expect(h.calls).toEqual([]);
    expect(h.ag.state().projects).toMatchObject([{ unit: PS, root: A, procs: 6 }]);
  });

  test('deux racines du même projet au même tick : un seul scope avec tous leurs PIDs', async () => {
    const h = harness();
    h.setProcs([...world(), vitest(720), p(721, 720, 'MainThread', `node ${NM}/vitest/dist/worker.js`, A)]);
    await h.step();
    expect(names(h.calls)).toEqual(['ensureSlice', 'ensureProjectSlice', 'startScope']);
    expect((h.calls[2]![3] as number[]).sort((a, b) => a - b)).toEqual([700, 701, 702, 703, 704, 720, 721]);
  });

  test(`plus de ${MAX_PIDS} PIDs : la racine reste dehors jusqu’au dernier lot, le reste suit au tick suivant`, async () => {
    const h = harness();
    const kids = Array.from({ length: 300 }, (_, k) => p(1000 + k, 700, 'MainThread', `node ${NM}/jest-worker/build/workers/processChild.js`, A));
    h.setProcs([...world().slice(0, 3), ...kids]);
    await h.step();
    const lot1 = h.calls.at(-1)![3] as number[];
    expect(lot1).toHaveLength(MAX_PIDS);
    expect(lot1).not.toContain(700);
    h.calls.length = 0;
    await h.step();
    expect(names(h.calls)).toEqual(['startScope']);
    const lot2 = h.calls[0]![3] as number[];
    expect(lot2).toContain(700);
    expect(new Set([...lot1, ...lot2]).size).toBe(301);
    h.calls.length = 0;
    await h.step();
    expect(h.calls).toEqual([]);
  });

  test('scope déjà connu de systemd (exists) : erreur journalisée une fois, autre nom au tick suivant', async () => {
    let n = 0;
    const h = harness({ fail: (m) => (m === 'startScope' && n++ === 0 ? new BusctlError('Call failed: Unit x was already loaded or has a fragment file.', 'exists') : null) });
    await h.step();
    const first = h.calls.at(-1)![1];
    expect(h.ag.state().lastError).toMatch(/already loaded/);
    h.calls.length = 0;
    await h.step();
    expect(h.calls).toEqual([['startScope', expect.stringMatching(SCOPE), PS, [700, 701, 702, 703, 704]]]);
    expect(h.calls[0]![1]).not.toBe(first);
    expect(h.logs.filter((l) => /already loaded/.test(l))).toHaveLength(1);
    expect(h.ag.state()).toMatchObject({ status: 'active', lastError: null });
  });

  test('slice de projet disparue : assurée de nouveau avant le scope suivant (jamais de scope vers une slice non assurée)', async () => {
    const h = harness();
    await h.step();
    h.sys.delete(PSCG);
    h.calls.length = 0;
    await h.step();
    expect(h.calls).toEqual([]); // rien à déplacer : aucun appel
    h.setProcs([...world(), vitest(720)]);
    await h.step();
    expect(h.calls).toEqual([['ensureProjectSlice', PS, null], ['startScope', expect.stringMatching(SCOPE), PS, [720]]]);
  });

  test('cwatch.slice disparue : plafonds reposés avant toute slice de projet', async () => {
    const h = harness();
    await h.step();
    h.sys.delete(ROOT);
    h.sys.delete(PSCG);
    h.calls.length = 0;
    await h.step();
    expect(h.calls).toEqual([]);
    h.setProcs([...world(), vitest(720)]);
    await h.step();
    expect(names(h.calls)).toEqual(['ensureSlice', 'ensureProjectSlice', 'startScope']);
  });

  test('échec de cwatch.slice : aucune slice de projet ni aucun scope dans le même enchaînement', async () => {
    let fail = true;
    const h = harness({ fail: (m) => (m === 'ensureSlice' && fail ? new BusctlError('Call failed: boom', 'other') : null) });
    await h.step();
    expect(names(h.calls)).toEqual(['ensureSlice']);
    fail = false;
    h.calls.length = 0;
    await h.step();
    expect(names(h.calls)).toEqual(['ensureSlice', 'ensureProjectSlice', 'startScope']);
  });

  test('budget : posé à la création de la slice du projet, changé, retiré ; un seul appel par changement', async () => {
    const h = harness();
    await h.step({ ...ON, budgets: { [A]: 4096 } });
    expect(h.calls[1]).toEqual(['ensureProjectSlice', PS, 4 * GiB]);
    h.calls.length = 0;
    await h.step({ ...ON, budgets: { [A]: 4096 } });
    expect(h.calls).toEqual([]);
    expect(h.ag.state().projects).toMatchObject([{ unit: PS, budgetMB: 4096 }]);
    await h.step({ ...ON, budgets: { [A]: 6144 } });
    expect(h.calls).toEqual([['setProjectHigh', PS, 6 * GiB]]);
    h.calls.length = 0;
    await h.step({ ...ON, budgets: { [A]: 6144 } });
    expect(h.calls).toEqual([]);
    await h.step(ON);
    expect(h.calls).toEqual([['setProjectHigh', PS, null]]);
    h.calls.length = 0;
    await h.step(ON);
    expect(h.calls).toEqual([]);
  });

  test('budget par défaut : posé sur un projet sans budget explicite, changé, retiré (null) ; un seul appel par changement', async () => {
    const h = harness();
    const def = (mb: number | null) => ({ ...ON, defaultBudgetMB: mb });
    await h.step(def(5120));
    expect(h.calls[1]).toEqual(['ensureProjectSlice', PS, 5 * GiB]);
    h.calls.length = 0;
    await h.step(def(5120));
    expect(h.calls).toEqual([]);
    expect(h.ag.state().projects).toMatchObject([{ unit: PS, budgetMB: 5120, budgetDefault: true }]);
    // défaut changé : appliqué au tick suivant
    await h.step(def(8192));
    expect(h.calls).toEqual([['setProjectHigh', PS, 8 * GiB]]);
    h.calls.length = 0;
    // défaut retiré : memory.high remis à infinity
    await h.step(def(null));
    expect(h.calls).toEqual([['setProjectHigh', PS, null]]);
    expect(h.ag.state().projects[0]).toMatchObject({ budgetMB: null });
    expect(h.ag.state().projects[0]).not.toHaveProperty('budgetDefault');
    h.calls.length = 0;
    await h.step(def(null));
    expect(h.calls).toEqual([]);
  });

  test('budget par défaut : le budget explicite l’emporte, « sans budget » l’écarte, hors projet jamais', async () => {
    const h = harness();
    await h.step({ ...ON, defaultBudgetMB: 5120, budgets: { [A]: 2048 } });
    expect(h.calls[1]).toEqual(['ensureProjectSlice', PS, 2 * GiB]);
    await h.step({ ...ON, defaultBudgetMB: 5120, budgets: { [A]: 2048 } });
    expect(h.ag.state().projects[0]).toMatchObject({ budgetMB: 2048 });
    expect(h.ag.state().projects[0]).not.toHaveProperty('budgetDefault');
    h.calls.length = 0;
    // budget explicite retiré : le défaut prend le relais
    await h.step({ ...ON, defaultBudgetMB: 5120 });
    expect(h.calls).toEqual([['setProjectHigh', PS, 5 * GiB]]);
    h.calls.length = 0;
    // projet explicitement sans budget : infinity malgré le défaut
    await h.step({ ...ON, defaultBudgetMB: 5120, noBudget: [A] });
    expect(h.calls).toEqual([['setProjectHigh', PS, null]]);
    h.calls.length = 0;
    // vérification hors projet : jamais le défaut
    const o = harness();
    o.setProcs([...world().slice(0, 2), p(810, 601, 'MainThread', 'node /usr/lib/node_modules/typescript/bin/tsc --noEmit', '/')]);
    await o.step({ ...ON, defaultBudgetMB: 5120 });
    expect(o.calls[1]).toEqual(['ensureProjectSlice', 'cwatch-p-autres.slice', null]);
  });

  test('budget par défaut : éteint → retiré comme un budget explicite ; redémarrage avec le défaut déjà posé (sysfs) → aucun appel', async () => {
    const h = harness();
    await h.step({ ...ON, defaultBudgetMB: 5120 });
    h.calls.length = 0;
    await h.step({ ...OFF, defaultBudgetMB: 5120 });
    expect(h.calls).toEqual([['setSlice', 'cwatch.slice', null], ['setProjectHigh', PS, null]]);
    // service redémarré : slice du projet déjà au budget par défaut dans sysfs
    const r = harness({ initialSlices: { [PS]: A } });
    r.cg.set(700, `${PSCG}/cwatch-p-alpha-x.scope`);
    r.sys.set(PSCG, stats({ highBytes: 5 * GiB, populated: true }));
    await r.step({ ...ON, defaultBudgetMB: 5120 });
    expect(r.calls.filter((c) => c[0] === 'setProjectHigh' || (c[0] === 'ensureProjectSlice' && c[2] !== 5 * GiB))).toEqual([]);
  });

  test('interrupteur éteint : cwatch.slice et slices de projet remises à infinity une seule fois, aucun déplacement', async () => {
    const h = harness();
    await h.step({ ...ON, budgets: { [A]: 4096 } });
    h.calls.length = 0;
    await h.step(OFF);
    expect(h.calls).toEqual([['setSlice', 'cwatch.slice', null], ['setProjectHigh', PS, null]]);
    h.calls.length = 0;
    h.setProcs([...world().slice(0, 2), vitest(720)]);
    for (let k = 0; k < 3; k++) await h.step(OFF);
    expect(h.calls).toEqual([]);
    expect(h.ag.state()).toMatchObject({ status: 'off', enabled: false, projects: [], slices: { [PS]: A } });
    expect(h.cg.has(720)).toBe(false);
  });

  test('rallumé après extinction : plafonds reposés, budget reposé', async () => {
    const h = harness();
    await h.step({ ...ON, budgets: { [A]: 4096 } });
    await h.step(OFF);
    h.calls.length = 0;
    await h.step({ ...ON, budgets: { [A]: 4096 } });
    expect(h.calls).toEqual([ROOT_CALL, ['setProjectHigh', PS, 4 * GiB]]);
  });

  test('éteint au démarrage (service redémarré) : plafonds et budgets encore posés remis à infinity, une seule fois', async () => {
    const h = harness({ initialSlices: { [PS]: A } });
    h.sys.set(ROOT, stats({ highBytes: 12 * GiB, maxBytes: 14 * GiB, swapMaxBytes: 4 * GiB }));
    h.sys.set(PSCG, stats({ highBytes: 4 * GiB }));
    for (const pid of [700, 701, 702, 703, 704]) h.cg.set(pid, `${PSCG}/cwatch-p-alpha-old.scope`);
    await h.step(OFF);
    expect(h.calls).toEqual([['setSlice', 'cwatch.slice', null], ['setProjectHigh', PS, null]]);
    h.calls.length = 0;
    for (let k = 0; k < 3; k++) await h.step(OFF);
    expect(h.calls).toEqual([]);
  });

  test('éteint : sysfs qui montre encore un plafond après la remise à infinity → aucun appel en boucle', async () => {
    const h = harness();
    await h.step();
    await h.step(OFF);
    h.sys.set(ROOT, stats({ highBytes: 12 * GiB }));
    h.calls.length = 0;
    for (let k = 0; k < 3; k++) await h.step(OFF);
    expect(h.calls).toEqual([]);
  });

  test('éteint au démarrage sans état : slice de projet retrouvée par les processus déjà rangés, budget retiré', async () => {
    const h = harness();
    h.sys.set(PSCG, stats({ highBytes: 4 * GiB }));
    for (const pid of [700, 701, 702, 703, 704]) h.cg.set(pid, `${PSCG}/cwatch-p-alpha-old.scope`);
    await h.step(OFF);
    expect(h.calls).toEqual([['setProjectHigh', PS, null]]);
  });

  test('éteint, rien de posé : aucun appel', async () => {
    const h = harness();
    for (let k = 0; k < 3; k++) await h.step(OFF);
    expect(h.calls).toEqual([]);
    expect(h.ag.state()).toMatchObject({ status: 'off' });
  });

  test('indisponible : aucun appel, raison dans l’état, nouvelle sonde après 5 min seulement', async () => {
    const h = harness({ avail: { ok: false, reason: 'busctl introuvable (/usr/bin/busctl)' } });
    for (let k = 0; k < 10; k++) await h.step();
    expect(h.calls).toEqual([]);
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.ag.state()).toMatchObject({ status: 'unavailable', reason: 'busctl introuvable (/usr/bin/busctl)' });
    await h.step(ON, PROBE_EVERY_MS);
    expect(h.probe).toHaveBeenCalledTimes(2);
  });

  test('accès refusé par systemd : indisponible 5 min, une seule ligne de journal, puis nouvelle sonde', async () => {
    const h = harness({ fail: (m) => (m === 'ensureSlice' ? new BusctlError('Call failed: Access denied', 'denied') : null) });
    await h.step();
    for (let k = 0; k < 5; k++) await h.step();
    expect(h.calls).toEqual([ROOT_CALL]);
    expect(h.ag.state()).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/injoignable : Call failed: Access denied/) });
    expect(h.logs.filter((l) => /Access denied/.test(l))).toHaveLength(1);
    await h.step(ON, PROBE_EVERY_MS);
    expect(h.probe).toHaveBeenCalledTimes(2);
    expect(h.calls).toEqual([ROOT_CALL, ROOT_CALL]);
  });

  test('busctl qui ne répond pas : le tick n’attend pas, aucun nouvel appel tant que l’enchaînement est en vol', () => {
    const h = harness({ hang: true });
    for (let k = 0; k < 3; k++) h.ag.tick(h.input(ON));
    expect(h.calls).toEqual([ROOT_CALL]);
    expect(h.ag.state()).toMatchObject({ status: 'active' });
  });

  test('OOM dans la slice du projet : renvoyé pour l’historique ; ralentissement : « ralenti » 15 s', async () => {
    const h = harness();
    await h.step();
    h.sys.set(PSCG, stats({ events: ev({ high: 2, oomKill: 1 }) }));
    expect(await h.step()).toEqual([]); // première lecture : référence
    h.sys.set(PSCG, stats({ events: ev({ high: 5, oomKill: 3 }) }));
    expect(await h.step()).toEqual([{ unit: PS, root: A, kills: 2 }]);
    expect(h.ag.state().projects[0]).toMatchObject({ throttled: true });
    await h.step(ON, THROTTLE_HOLD_MS + 1000);
    expect(h.ag.state().projects[0]).toMatchObject({ throttled: false });
    h.sys.set(PSCG, stats({ events: ev({ high: 0, oomKill: 0 }) })); // slice recréée : compteurs repartis de zéro
    expect(await h.step()).toEqual([]);
  });

  test('redémarrage sans état : processus déjà sous la slice du projet → attribution reconstruite, aucun déplacement', async () => {
    const h = harness();
    h.sys.set(PSCG, stats());
    for (const pid of [700, 701, 702, 703, 704]) h.cg.set(pid, `${PSCG}/cwatch-p-alpha-old.scope`);
    await h.step();
    await h.step();
    expect(names(h.calls)).toEqual(['ensureSlice']);
    expect(h.ag.state().slices).toEqual({ [PS]: A });
    expect(h.ag.state().projects).toMatchObject([{ unit: PS, root: A, procs: 5 }]);
  });

  test('redémarrage : attribution relue sans doublon ; une entrée invraisemblable est écartée', async () => {
    const other = '/srv/alpha';
    const hashed = `cwatch-p-alpha_${shortHash(A)}.slice`;
    const h = harness({
      roots: { [other]: other },
      initialSlices: { [PS]: other, 'cwatch-p-beta.slice': A, 'cwatch-e2eabc-x.slice': A, 'cwatch-p-autres.slice': A, 'cwatch-p-gamma.slice': null },
    });
    const HCG = `${ROOT}/cwatch-p.slice/${hashed}`;
    h.sys.set(PSCG, stats());
    h.sys.set(HCG, stats());
    for (const pid of [700, 701, 702, 703, 704]) h.cg.set(pid, `${HCG}/cwatch-p-alpha_${shortHash(A)}-old.scope`);
    await h.step();
    expect(h.ag.state().slices).toEqual({ [PS]: other, [hashed]: A });
    expect(names(h.calls)).toEqual(['ensureSlice']);
    // un nouveau lot du projet va dans sa slice (hachée), jamais dans celle de l'autre racine
    h.calls.length = 0;
    h.setProcs([...world(), vitest(720)]);
    await h.step();
    expect(h.calls).toEqual([['ensureProjectSlice', hashed, null], ['startScope', expect.stringMatching(/^cwatch-p-alpha_[0-9a-f]{6}-[a-z0-9]+\.scope$/), hashed, [720]]]);
  });

  test('redémarrage : deux slices relues pour la même racine → une seule gardée', async () => {
    const hashed = `cwatch-p-alpha_${shortHash(A)}.slice`;
    const h = harness({ initialSlices: { [PS]: A, [hashed]: A } });
    h.sys.set(PSCG, stats());
    h.sys.set(`${ROOT}/cwatch-p.slice/${hashed}`, stats());
    await h.step();
    expect(h.ag.state().slices).toEqual({ [PS]: A });
  });

  test('processus comptés dans la slice : seulement ceux qui y sont vraiment', async () => {
    const h = harness();
    h.sys.set(PSCG, stats());
    for (const pid of [700, 701, 702, 703]) h.cg.set(pid, `${PSCG}/cwatch-p-alpha-old.scope`);
    await h.step();
    expect(h.ag.state().projects).toMatchObject([{ unit: PS, procs: 4 }]);
  });

  test('mémoire hors budget : processus de la slice (mémoire anonyme) nettement au-delà de memory.current → outsideKB', async () => {
    const h = harness();
    h.sys.set(PSCG, stats()); // 1 Gio comptés par la slice
    h.setProcs(world().map((x) => ({ ...x, anonKB: 1_000_000 })));
    for (const pid of [700, 701, 702, 703, 704]) h.cg.set(pid, `${PSCG}/cwatch-p-alpha-old.scope`);
    await h.step();
    expect(h.ag.state().projects).toEqual([expect.objectContaining({ unit: PS, procs: 5, currentKB: 1024 * 1024, outsideKB: 5_000_000 - 1024 * 1024 })]);
    // écart faible (cache de fichiers, arrondis) : rien
    h.setProcs(world().map((x) => ({ ...x, anonKB: 250_000 })));
    await h.step();
    expect(h.ag.state().projects[0]).not.toHaveProperty('outsideKB');
    // processus encore hors de la slice : jamais comptés (les cinq dedans dépasseraient)
    h.setProcs(world().map((x) => ({ ...x, anonKB: 600_000 })));
    for (const pid of [702, 703, 704]) h.cg.set(pid, WARP);
    await h.step();
    expect(h.ag.state().projects[0]).not.toHaveProperty('outsideKB');
  });

  test('redémarrage : processus rangés dans la slice d’une autre racine → aucune attribution, aucun doublon', async () => {
    const other = '/srv/alpha';
    const h = harness({ roots: { [other]: other }, initialSlices: { [PS]: other } });
    h.sys.set(PSCG, stats());
    for (const pid of [700, 701, 702, 703, 704]) h.cg.set(pid, `${PSCG}/cwatch-p-alpha-old.scope`);
    await h.step();
    expect(h.ag.state().slices).toEqual({ [PS]: other });
  });

  test('slice de projet relue mais disparue (session redémarrée) : attribution oubliée', async () => {
    const h = harness({ initialSlices: { 'cwatch-p-beta.slice': '/home/u/beta' } });
    await h.step();
    expect(h.ag.state().slices).toEqual({ [PS]: A });
  });

  test('réserve trop grande : aucun plafond, aucune slice de projet, aucun déplacement ; raison dans l’état', async () => {
    const h = harness();
    await h.step({ ...ON, reserveMB: 16_000 });
    expect(h.calls).toEqual([]);
    expect(h.cg.size).toBe(0);
    expect(h.ag.state()).toMatchObject({ status: 'unavailable', reason: 'réserve trop grande : moins de 1 Go laissé au travail', projects: [] });
  });

  test('réserve devenue trop grande : plafonds et budgets retirés une fois, plus aucun déplacement', async () => {
    const h = harness();
    await h.step({ ...ON, budgets: { [A]: 4096 } });
    h.calls.length = 0;
    const big = { ...ON, reserveMB: 16_000, budgets: { [A]: 4096 } };
    await h.step(big);
    expect(h.calls).toEqual([['setSlice', 'cwatch.slice', null], ['setProjectHigh', PS, null]]);
    h.calls.length = 0;
    h.setProcs([...world(), vitest(720)]);
    for (let k = 0; k < 3; k++) await h.step(big);
    expect(h.calls).toEqual([]);
  });

  test('vérification hors projet (tsc lancé depuis /) : slice « autres »', async () => {
    const h = harness();
    h.setProcs([...world().slice(0, 2), p(810, 601, 'MainThread', 'node /usr/lib/node_modules/typescript/bin/tsc --noEmit', '/')]);
    await h.step();
    expect(h.calls.slice(1)).toEqual([
      ['ensureProjectSlice', 'cwatch-p-autres.slice', null],
      ['startScope', expect.stringMatching(/^cwatch-p-autres-[a-z0-9]+\.scope$/), 'cwatch-p-autres.slice', [810]],
    ]);
    expect(h.ag.state().slices).toEqual({ 'cwatch-p-autres.slice': null });
  });

  test('dossiers de config de Claude transmis au plan : le shell de l’outil Bash d’un dossier personnalisé n’est pas à Claude', async () => {
    const dir = '/home/u/.config/claude-alt';
    const procs = [...world().slice(0, 2), p(800, 601, 'claude', 'claude'),
      p(801, 800, 'zsh', `/bin/zsh -c source ${dir}/shell-snapshots/s.sh && tsc --noEmit`),
      p(810, 801, 'MainThread', 'node /usr/lib/node_modules/typescript/bin/tsc --noEmit', '/')];
    const without = harness();
    without.setProcs(procs);
    await without.step();
    expect(names(without.calls)).toEqual(['ensureSlice']);
    const h = harness();
    h.setProcs(procs);
    h.setClaudeDirs([dir]);
    await h.step();
    expect(h.calls.at(-1)).toEqual(['startScope', expect.stringMatching(/^cwatch-p-autres-/), 'cwatch-p-autres.slice', [810]]);
  });

  test('noms de scope : uniques et valides même avec une horloge murale absurde', async () => {
    const h = harness();
    h.setProcs([...world().slice(0, 2), vitest(720)]);
    const i = h.input(ON);
    h.ag.tick({ ...i, ts: Number.NaN });
    await h.ag.idle();
    h.setProcs([...world().slice(0, 2), vitest(720), vitest(721)]);
    h.ag.tick({ ...h.input(ON), ts: -5 });
    await h.ag.idle();
    const scopes = h.calls.filter((c) => c[0] === 'startScope').map((c) => c[1]);
    expect(scopes).toHaveLength(2);
    expect(new Set(scopes).size).toBe(2);
    for (const s of scopes) expect(s).toMatch(SCOPE);
  });

  test('plafond global qui freine (high de cwatch.slice) : projets peuplés « ralentis » 15 s, même sans budget', async () => {
    const h = harness();
    await h.step();
    h.sys.set(ROOT, { ...h.sys.get(ROOT)!, events: ev({ high: 2 }) });
    await h.step(); // première lecture : référence
    expect(h.ag.state().projects).toMatchObject([{ unit: PS, throttled: false }]);
    h.sys.set(ROOT, { ...h.sys.get(ROOT)!, events: ev({ high: 9 }) });
    await h.step();
    expect(h.ag.state().projects).toMatchObject([{ unit: PS, throttled: true }]);
    await h.step(ON, THROTTLE_HOLD_MS + 1000);
    expect(h.ag.state().projects).toMatchObject([{ unit: PS, throttled: false }]);
  });

  test('freinage récent : plafond global (cwatch.slice) ou budget du projet, et part de la dernière minute d’après memory.pressure', async () => {
    const h = harness();
    await h.step();
    h.sys.set(ROOT, { ...h.sys.get(ROOT)!, events: ev({ high: 2 }), stallUs: 0 });
    await h.step(); // référence
    expect(h.ag.state().slice).not.toHaveProperty('stallPct');
    expect(h.ag.state().slice).toMatchObject({ throttled: false });
    h.sys.set(ROOT, { ...h.sys.get(ROOT)!, events: ev({ high: 5 }), stallUs: 2_500_000 });
    await h.step();
    expect(h.ag.state().slice).toMatchObject({ throttled: true, stallPct: 50 });
    expect(h.ag.state().projects).toMatchObject([{ unit: PS, throttled: true, budgetThrottled: false }]);
    await h.step(ON, THROTTLE_HOLD_MS + 1000);
    expect(h.ag.state().slice).toMatchObject({ throttled: false, stallPct: 12 });
    await h.step(ON, 60_000);
    expect(h.ag.state().slice).not.toHaveProperty('stallPct');
    // budget du projet : freinage propre à sa slice
    h.sys.set(PSCG, { ...h.sys.get(PSCG)!, events: ev({ high: 1 }), stallUs: 0 });
    await h.step();
    h.sys.set(PSCG, { ...h.sys.get(PSCG)!, events: ev({ high: 7 }), stallUs: 4_000_000 });
    await h.step();
    expect(h.ag.state().slice).toMatchObject({ throttled: false });
    expect(h.ag.state().projects).toMatchObject([{ unit: PS, throttled: true, budgetThrottled: true, stallPct: 80 }]);
  });

  test('slice de projet vide (aucun processus) : ni « plafonnée » ni comptée ; gardée pour son budget', async () => {
    const h = harness({ initialSlices: { [PS]: A } });
    h.sys.set(PSCG, stats({ populated: false, highBytes: 4 * GiB }));
    h.setProcs(world().slice(0, 2));
    await h.step();
    expect(h.ag.state().projects).toEqual([]);
    expect(h.ag.state().slices).toEqual({ [PS]: A });
    expect(h.calls).toEqual([ROOT_CALL, ['setProjectHigh', PS, null]]);
    h.sys.set(PSCG, { ...h.sys.get(PSCG)!, populated: true });
    await h.step();
    expect(h.ag.state().projects).toMatchObject([{ unit: PS, root: A }]);
  });

  test('budget en échec persistant sur un projet : les déplacements des autres projets partent quand même, sans nouvel essai à chaque tick', async () => {
    const B = '/home/u/beta';
    const h = harness({ roots: { [B]: B }, fail: (m, a) => (m === 'setProjectHigh' && a[0] === PS ? new BusctlError('Call failed: boom', 'other') : null) });
    await h.step();
    h.calls.length = 0;
    const withBudget = { ...ON, budgets: { [A]: 4096 } };
    h.setProcs([...world(), p(730, 601, 'MainThread', `node ${B}/node_modules/vitest/vitest.mjs run`, B)]);
    await h.step(withBudget);
    expect(h.calls).toEqual([
      ['setProjectHigh', PS, 4 * GiB],
      ['ensureProjectSlice', 'cwatch-p-beta.slice', null],
      ['startScope', expect.stringMatching(/^cwatch-p-beta-[a-z0-9]+\.scope$/), 'cwatch-p-beta.slice', [730]],
    ]);
    expect(h.ag.state().lastError).toMatch(/boom/);
    h.calls.length = 0;
    await h.step(withBudget);
    expect(h.calls).toEqual([]); // recul : pas un busctl par tick
    await h.step(withBudget, BUDGET_RETRY_MS);
    expect(h.calls).toEqual([['setProjectHigh', PS, 4 * GiB]]);
  });

  test('budget refusé en no-unit (slice inconnue de systemd) : repassage par ensureProjectSlice, puis plus aucun appel', async () => {
    const h = harness({ fail: (m) => (m === 'setProjectHigh' ? new BusctlError(`Call failed: Unit ${PS} not loaded.`, 'no-unit') : null) });
    await h.step();
    h.calls.length = 0;
    const withBudget = { ...ON, budgets: { [A]: 4096 } };
    await h.step(withBudget);
    expect(h.calls).toEqual([['setProjectHigh', PS, 4 * GiB]]);
    h.calls.length = 0;
    await h.step(withBudget);
    expect(h.calls).toEqual([['ensureProjectSlice', PS, 4 * GiB]]);
    h.calls.length = 0;
    await h.step(withBudget);
    expect(h.calls).toEqual([]);
  });

  test('slice de projet dont le cgroup existe déjà sans être attribuée ici : jamais réattribuée à une autre racine (nom haché)', async () => {
    const h = harness();
    h.sys.set(PSCG, stats()); // processus d'une racine perdue (état illisible), plus sous aucune ancre
    await h.step();
    const hashed = `cwatch-p-alpha_${shortHash(A)}.slice`;
    expect(h.calls).toEqual([
      ROOT_CALL,
      ['ensureProjectSlice', hashed, null],
      ['startScope', expect.stringMatching(/^cwatch-p-alpha_[0-9a-f]{6}-[a-z0-9]+\.scope$/), hashed, [700, 701, 702, 703, 704]],
    ]);
    expect(h.ag.state().slices).toEqual({ [hashed]: A });
  });

  test('workMemo élagué sur son propre seuil (commandes non déplacées à fort roulement)', async () => {
    const memo = new Map<string, boolean>();
    const h = harness({ workMemo: memo });
    let pid = 5000;
    for (let k = 0; k < 60; k++) {
      h.setProcs([...world().slice(0, 2), ...Array.from({ length: 20 }, () => p(pid++, 601, 'git', 'git status'))]);
      await h.step();
    }
    expect(memo.size).toBeGreaterThan(0);
    expect(memo.size).toBeLessThanOrEqual(4 * 22 + 100 + 20);
  });
});

describe('plafond dynamique de cwatch.slice', () => {
  const GKB = 1024 * 1024;
  const setWork = (h: ReturnType<typeof harness>, bytes: number) => h.sys.set(ROOT, { ...(h.sys.get(ROOT) ?? stats({ currentBytes: 0 })), currentBytes: bytes });
  const rootCalls = (calls: unknown[][]) => calls.filter((c) => c[0] === 'setSlice' || c[0] === 'ensureSlice');

  test('RAM qui se remplit hors travail : le plafond descend à travail + (MemAvailable − réserve) ; MemoryMax inchangé', async () => {
    const h = harness();
    await h.step();
    expect(h.calls[0]).toEqual(ROOT_CALL);
    setWork(h, 3 * GiB);
    h.setSystem({ memAvailableKB: 6 * GKB }); // navigateurs : 7 Go pris hors travail
    h.calls.length = 0;
    await h.step();
    expect(h.calls).toEqual([['setSlice', 'cwatch.slice', 5 * GiB]]);
    expect(h.sys.get(ROOT)).toMatchObject({ highBytes: 5 * GiB, maxBytes: 14 * GiB, swapMaxBytes: 4 * GiB });
    // RAM pleine : plus aucune marge, le plafond colle au travail
    h.setSystem({ memAvailableKB: 3 * GKB });
    h.calls.length = 0;
    await h.step();
    expect(h.calls).toEqual([['setSlice', 'cwatch.slice', 3 * GiB]]);
    await h.step(); // l'état publie ce que montre sysfs au tick suivant
    expect(h.ag.state().slice).toMatchObject({ currentKB: 3 * GKB, highKB: 3 * GKB, maxKB: 14 * GKB });
  });

  test('mémoire libérée hors travail : le plafond remonte, jamais au-delà de RAM − réserve', async () => {
    const h = harness();
    setWork(h, 0);
    h.setSystem({ memAvailableKB: 6 * GKB });
    await h.step();
    expect(h.calls[0]).toEqual(['ensureSlice', 'cwatch.slice', 2 * GiB, 14 * GiB, 4 * GiB]);
    setWork(h, 3 * GiB);
    h.setSystem({ memAvailableKB: 7 * GKB });
    h.calls.length = 0;
    await h.step();
    expect(rootCalls(h.calls)).toEqual([['setSlice', 'cwatch.slice', 6 * GiB]]);
    h.setSystem({ memAvailableKB: 15 * GKB });
    h.calls.length = 0;
    await h.step();
    expect(rootCalls(h.calls)).toEqual([['setSlice', 'cwatch.slice', 12 * GiB]]);
  });

  test('quelques Mo d’écart (moins de 256 Mo) : aucun SetUnitProperties', async () => {
    const h = harness();
    await h.step();
    setWork(h, 3 * GiB);
    h.setSystem({ memAvailableKB: 6 * GKB });
    await h.step();
    h.calls.length = 0;
    for (const mb of [100, -150, 200, 50]) {
      h.setSystem({ memAvailableKB: 6 * GKB + mb * 1024 });
      await h.step();
    }
    expect(h.calls).toEqual([]);
  });

  test('MemAvailable illisible : plafond statique (RAM − réserve)', async () => {
    const h = harness();
    setWork(h, 3 * GiB);
    h.setSystem({ memAvailableKB: 0, memAvailableKnown: false });
    await h.step();
    expect(h.calls[0]).toEqual(ROOT_CALL);
    h.setSystem({ memAvailableKB: 6 * GKB });
    h.calls.length = 0;
    await h.step();
    expect(rootCalls(h.calls)).toEqual([['setSlice', 'cwatch.slice', 5 * GiB]]);
    h.setSystem({ memAvailableKB: 0, memAvailableKnown: false });
    h.calls.length = 0;
    await h.step();
    expect(rootCalls(h.calls)).toEqual([['setSlice', 'cwatch.slice', 12 * GiB]]);
  });

  test('seule cwatch.slice est replafonnée : jamais une autre unité', async () => {
    const h = harness();
    await h.step();
    for (const [w, a] of [[3, 6], [3, 3], [1, 15], [8, 9]] as const) {
      setWork(h, w * GiB);
      h.setSystem({ memAvailableKB: a * GKB });
      await h.step();
    }
    const units = new Set(h.calls.filter((c) => c[0] === 'setSlice' || c[0] === 'ensureSlice').map((c) => c[1]));
    expect([...units]).toEqual(['cwatch.slice']);
    expect(h.calls.every((c) => ['ensureSlice', 'setSlice', 'ensureProjectSlice', 'startScope'].includes(c[0] as string))).toBe(true);
  });
});

describe('bureau prioritaire branché sur l’orchestrateur', () => {
  /** Faux sysfs du bureau (poids 100) et faux client du bureau : aucun busctl. */
  function deskHarness() {
    const files = new Map<string, Record<string, string>>();
    for (const cg of ['/user.slice', '/user.slice/user-1000.slice', `${BASE}/session.slice`, `${BASE}/app.slice`, WARP, ROOT]) {
      files.set(cg, { 'cgroup.controllers': 'cpu memory', 'cpu.weight': '100', 'memory.low': '0', 'memory.min': '0' });
    }
    files.set(BASE, { 'cgroup.subtree_control': 'cpu memory pids', 'memory.low': '0', 'memory.min': '0' });
    const deskCalls: [string, unknown][] = [];
    const fake = fakeSystemd({ userBase: BASE });
    let mono = 0;
    const ag = createAntigel({
      client: fake.client, probe: () => ({ ok: true, userBase: BASE, busctl: '/usr/bin/busctl' }), reverify: (t) => [...t], log: () => {},
      monoNow: () => mono, perfNow: () => 0, stats: (path) => fake.sys.get(path) ?? null, cgroupOf: (pid) => fake.cg.get(pid) ?? WARP,
      desk: {
        client: {
          setProps: async (unit, props) => {
            deskCalls.push([unit, props]);
            const f = [...files].find(([k]) => k.endsWith(`/${unit}`))?.[1];
            if (f && props.cpuWeight !== undefined) f['cpu.weight'] = String(props.cpuWeight ?? 100);
          },
          calls: () => deskCalls.length,
        },
        readCg: (cg, file) => files.get(cg)?.[file] ?? null,
      },
    });
    const procs = world();
    const step = async (config: AntigelConfig) => {
      mono += 5000;
      ag.tick({
        ts: 1_000_000 + mono, procs, system: SYS, config, currentUid: 1000, selfPid: 900, appRoot: null, home: '/home/u',
        isProtected: (n: string) => ['zsh', 'warp'].includes(n), groups: [],
      });
      await ag.idle();
    };
    return { ag, deskCalls, step };
  }

  test('actif : poids posés, état publié et appels comptés ; éteint ou interrupteur du bureau coupé : origines restaurées', async () => {
    const h = deskHarness();
    await h.step(ON);
    await h.step(ON); // cwatch.slice créée au premier tick : son poids suit
    expect(h.deskCalls.map((c) => c[0])).toEqual(['session.slice', 'app.slice', 'cwatch.slice']);
    expect(h.ag.state().desk).toMatchObject({ status: 'active', cpu: true, memory: 'ineffective' });
    expect(h.ag.state().dbusCalls).toBeGreaterThanOrEqual(3);
    h.deskCalls.length = 0;
    await h.step({ ...ON, desk: false });
    expect(h.deskCalls).toEqual([['session.slice', { cpuWeight: null }], ['app.slice', { cpuWeight: null }], ['cwatch.slice', { cpuWeight: null }]]);
    expect(h.ag.state().desk).toMatchObject({ status: 'off', restoring: 0 });
    await h.step(ON);
    await h.step(ON);
    h.deskCalls.length = 0;
    await h.step(OFF);
    expect(h.deskCalls.map((c) => c[0])).toEqual(['session.slice', 'app.slice', 'cwatch.slice']);
  });

  test('erreur du bureau prioritaire : le plafond de travail continue', async () => {
    const fake = fakeSystemd({ userBase: BASE });
    const logs: string[] = [];
    const ag = createAntigel({
      client: fake.client, probe: () => ({ ok: true, userBase: BASE, busctl: '/usr/bin/busctl' }), reverify: (t) => [...t], log: (m) => logs.push(m),
      monoNow: () => 0, perfNow: () => 0, stats: (path) => fake.sys.get(path) ?? null, cgroupOf: () => WARP,
      desk: { client: { setProps: async () => {}, calls: () => 0 }, readCg: () => { throw new Error('sysfs cassé'); } },
    });
    expect(() => ag.tick({ ts: 1, procs: world(), system: SYS, config: ON, currentUid: 1000, selfPid: 900, appRoot: null, home: '/home/u', isProtected: () => false, groups: [] })).not.toThrow();
    await ag.idle();
    expect(names(fake.calls)).toContain('ensureSlice');
    expect(logs.some((l) => l.includes('sysfs cassé'))).toBe(true);
  });

  test('sans dépendances du bureau : aucun champ desk', async () => {
    const h = harness();
    await h.step();
    expect(h.ag.state()).not.toHaveProperty('desk');
  });
});

describe('racine trop jeune : revue une seconde plus tard', () => {
  const young = (age: number) => world().map((x) => (x.pid === 700 ? { ...x, ageSec: age } : x));

  test('refus « young » : aucun scope, nouvelle passe demandée dans 1 s ; une fois déplacée : plus rien', async () => {
    const h = harness();
    h.setProcs(young(0.3));
    await h.step();
    expect(names(h.calls)).toEqual(['ensureSlice']);
    expect(h.ag.recheckMs()).toBe(RECHECK_YOUNG_MS);
    expect(RECHECK_YOUNG_MS).toBe(1000);
    h.setProcs(young(1.3));
    await h.step(ON, RECHECK_YOUNG_MS);
    expect(names(h.calls)).toEqual(['ensureSlice', 'ensureProjectSlice', 'startScope']);
    expect(h.ag.recheckMs()).toBeNull();
  });

  test('régime normal (aucune racine jeune), éteint ou indisponible : aucune passe de plus', async () => {
    const h = harness();
    await h.step();
    expect(h.ag.recheckMs()).toBeNull();
    h.setProcs(young(0.3));
    await h.step(OFF);
    expect(h.ag.recheckMs()).toBeNull();
    const u = harness({ avail: { ok: false, reason: 'pas de cgroups v2' } });
    u.setProcs(young(0.3));
    await u.step();
    expect(u.ag.recheckMs()).toBeNull();
  });
});
