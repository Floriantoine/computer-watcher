import { describe, expect, test } from 'vitest';
import type { ProcInfo } from '../types';
import { INFINITY_T } from './limits';
import { DESK_PROBE_MS, DESK_RECHECK_MS, DESK_RETRY_MS, MAX_ORIGINALS, createDeskPriority, sanitizeOriginals, type DeskOriginals } from './desk';
import { createDeskClient } from './deskSystemd';
import { BusctlError } from './systemd';

const BASE = '/user.slice/user-1000.slice/user@1000.service';
const WARP_UNIT = 'app-dev.warp.Warp@1.service';
const WARP = `${BASE}/app.slice/${WARP_UNIT}`;
const SESSION = `${BASE}/session.slice`;
const APP = `${BASE}/app.slice`;
const ROOT = `${BASE}/cwatch.slice`;
const R = 4 * 1024 ** 3;

const proc = (pid: number, name: string): ProcInfo => ({
  pid, ppid: 1, name, cmdline: name, uid: 1000, startTicks: pid, ageSec: 100, cpuTicks: 0, cpuPercent: 0, rssKB: 1, swapKB: 0, cwd: null, cwdDeleted: false,
});

/** Faux /sys/fs/cgroup (cgroup → fichiers) et vrai client du bureau sur un faux busctl qui applique l'argv validé. */
function world(o: { protectedChain?: boolean; io?: boolean; fail?: (unit: string) => BusctlError | null; inert?: boolean } = {}) {
  const sys = new Map<string, Record<string, string>>();
  const cg = (path: string, files: Record<string, string> = {}) => sys.set(path, { 'cgroup.controllers': 'cpu memory pids', 'cpu.weight': '100', 'memory.low': '0', 'memory.min': '0', ...(o.io ? { 'io.weight': 'default 100\n' } : {}), ...files });
  const low = o.protectedChain ? String(8 * 1024 ** 3) : '0';
  cg('/user.slice', { 'memory.low': low });
  cg('/user.slice/user-1000.slice', { 'memory.low': low });
  cg(BASE, { 'memory.low': low, 'cgroup.subtree_control': o.io ? 'cpu io memory pids' : 'cpu memory pids' });
  cg(SESSION);
  cg(APP);
  cg(WARP);
  cg(ROOT);
  const calls: { unit: string; props: Record<string, string> }[] = [];
  const order: string[] = [];
  const client = createDeskClient(async (argv) => {
    const unit = argv[8]!;
    const n = Number(argv[10]);
    const props: Record<string, string> = {};
    for (let k = 0; k < n; k++) props[argv[11 + 3 * k]!] = argv[13 + 3 * k]!;
    calls.push({ unit, props });
    order.push(`set:${unit}`);
    const err = o.fail?.(unit);
    if (err) throw err;
    if (o.inert) return;
    const path = [...sys.keys()].find((p) => p.endsWith(`/${unit}`));
    if (!path) return; // comme systemd : une unité inconnue « réussit »
    const f = sys.get(path)!;
    const w = (v: string) => (v === INFINITY_T ? '100' : v);
    if (props.CPUWeight) f['cpu.weight'] = w(props.CPUWeight);
    if (props.IOWeight) f['io.weight'] = `default ${w(props.IOWeight)}\n`;
    if (props.MemoryLow) f['memory.low'] = props.MemoryLow === INFINITY_T ? 'max' : props.MemoryLow;
  });
  let now = 1_000_000;
  const saved: DeskOriginals[] = [];
  const logs: string[] = [];
  const reads = { n: 0 };
  const make = (originals?: DeskOriginals) =>
    createDeskPriority({
      client,
      readCg: (path, file) => {
        reads.n++;
        return sys.get(path)?.[file] ?? null;
      },
      loadOriginals: originals ? () => originals : undefined,
      saveOriginals: (x) => {
        saved.push(structuredClone(x));
        order.push('save');
      },
      monoNow: () => now,
      log: (m) => logs.push(m),
    });
  const input = (on: boolean, procs: ProcInfo[] = [proc(10, 'warp'), proc(11, 'claude')]) => ({
    on, userBase: BASE, procs, uid: 1000, cgroupOf: (pid: number) => (pid === 10 || pid === 11 ? WARP : null), reserveBytes: R, rootExists: true,
  });
  return { sys, calls, order, saved, logs, reads, make, input, advance: (ms: number) => (now += ms) };
}

describe('bureau prioritaire', () => {
  test('poids posés une fois (origines enregistrées avant), puis aucun appel en régime établi', async () => {
    const w = world();
    const d = w.make();
    d.tick(w.input(true));
    await d.idle();
    expect(w.calls).toEqual([
      { unit: 'session.slice', props: { CPUWeight: '200' } },
      { unit: 'app.slice', props: { CPUWeight: '150' } },
      { unit: 'cwatch.slice', props: { CPUWeight: '50' } },
    ]);
    expect(w.order[0]).toBe('save');
    expect(w.saved[0]).toEqual({
      'session.slice': { cgroup: SESSION, cpuWeight: null }, 'app.slice': { cgroup: APP, cpuWeight: null }, 'cwatch.slice': { cgroup: ROOT, cpuWeight: null },
    });
    expect(w.sys.get(SESSION)!['cpu.weight']).toBe('200');
    for (let k = 0; k < 20; k++) d.tick(w.input(true));
    await d.idle();
    expect(w.calls).toHaveLength(3);
    expect(d.state()).toMatchObject({ status: 'active', cpu: true, io: false, memory: 'ineffective', units: ['session.slice', 'app.slice', 'cwatch.slice'], restoring: 0 });
  });

  test('régime établi : unités conformes relues au plus toutes les 30 s, réaction immédiate si la valeur voulue change', async () => {
    const w = world();
    const d = w.make();
    d.tick(w.input(true));
    await d.idle();
    d.tick(w.input(true)); // conformité constatée
    w.reads.n = 0;
    for (let k = 0; k < 5; k++) {
      w.advance(5000);
      d.tick(w.input(true));
    }
    expect(w.reads.n).toBe(0);
    w.advance(DESK_RECHECK_MS);
    d.tick(w.input(true));
    expect(w.reads.n).toBeGreaterThan(0);
    // valeur changée de l'extérieur : reposée au plus tard 30 s après
    w.sys.get(SESSION)!['cpu.weight'] = '100';
    w.advance(DESK_RECHECK_MS);
    d.tick(w.input(true));
    await d.idle();
    expect(w.calls.at(-1)).toEqual({ unit: 'session.slice', props: { CPUWeight: '200' } });
  });

  test('éteint : valeurs d’origine restaurées (100 → non défini, valeur propre gardée), origines vidées', async () => {
    const w = world();
    w.sys.get(APP)!['cpu.weight'] = '80';
    const d = w.make();
    d.tick(w.input(true));
    await d.idle();
    w.calls.length = 0;
    d.tick(w.input(false));
    await d.idle();
    expect(w.calls).toEqual([
      { unit: 'session.slice', props: { CPUWeight: INFINITY_T } },
      { unit: 'app.slice', props: { CPUWeight: '80' } },
      { unit: 'cwatch.slice', props: { CPUWeight: INFINITY_T } },
    ]);
    expect(w.sys.get(APP)!['cpu.weight']).toBe('80');
    expect(w.saved.at(-1)).toEqual({});
    d.tick(w.input(false));
    await d.idle();
    expect(w.calls).toHaveLength(3);
    expect(d.state()).toMatchObject({ status: 'off', cpu: false, memory: 'off', units: [], restoring: 0 });
  });

  test('service relancé : origines relues dans le fichier ; sans fichier, une valeur égale à la nôtre est rendue au défaut', async () => {
    const w = world();
    w.sys.get(SESSION)!['cpu.weight'] = '200';
    w.sys.get(APP)!['cpu.weight'] = '150';
    const d = w.make({ 'app.slice': { cgroup: APP, cpuWeight: 70 } });
    d.tick(w.input(true));
    await d.idle();
    d.tick(w.input(false));
    await d.idle();
    expect(w.calls.filter((c) => c.unit !== 'cwatch.slice')).toEqual([
      { unit: 'app.slice', props: { CPUWeight: '70' } }, // origines relues d'abord
      { unit: 'session.slice', props: { CPUWeight: INFINITY_T } },
    ]);
  });

  test('éteint dès le démarrage avec des origines relues : restaurées sans rien poser', async () => {
    const w = world();
    w.sys.get(SESSION)!['cpu.weight'] = '200';
    const d = w.make({ 'session.slice': { cgroup: SESSION, cpuWeight: null }, 'app.slice': { cgroup: APP, cpuWeight: null } });
    d.tick(w.input(false));
    await d.idle();
    expect(w.calls).toEqual([{ unit: 'session.slice', props: { CPUWeight: INFINITY_T } }]); // app.slice déjà à 100 : aucun appel
    expect(w.saved.at(-1)).toEqual({});
  });

  test('protection mémoire : posée seulement si les niveaux système sont protégés ; sur session.slice, app.slice et l’unité du terminal', async () => {
    const w = world({ protectedChain: true });
    const d = w.make();
    d.tick(w.input(true));
    await d.idle();
    expect(w.calls).toEqual([
      { unit: 'session.slice', props: { MemoryLow: String(R), CPUWeight: '200' } },
      { unit: 'app.slice', props: { MemoryLow: String(R), CPUWeight: '150' } },
      { unit: WARP_UNIT, props: { MemoryLow: String(R) } },
      { unit: 'cwatch.slice', props: { CPUWeight: '50' } },
    ]);
    expect(d.state().memory).toBe('on');
    // la protection devient sans effet (sondée toutes les 5 min) : retirée, poids gardés
    for (const p of ['/user.slice', '/user.slice/user-1000.slice', BASE]) w.sys.get(p)!['memory.low'] = '0';
    w.calls.length = 0;
    w.advance(DESK_PROBE_MS);
    d.tick(w.input(true));
    await d.idle();
    expect(w.calls).toEqual([
      { unit: 'session.slice', props: { MemoryLow: '0' } },
      { unit: 'app.slice', props: { MemoryLow: '0' } },
      { unit: WARP_UNIT, props: { MemoryLow: '0' } },
    ]);
    expect(d.state().memory).toBe('ineffective');
  });

  test('E/S : IOWeight seulement si io est délégué', async () => {
    const w = world({ io: true });
    const d = w.make();
    d.tick(w.input(true));
    await d.idle();
    expect(w.calls[0]).toEqual({ unit: 'session.slice', props: { CPUWeight: '200', IOWeight: '200' } });
    expect(w.calls[2]).toEqual({ unit: 'cwatch.slice', props: { CPUWeight: '50', IOWeight: '50' } });
    expect(d.state().io).toBe(true);
  });

  test('terminal fermé : unité du terminal oubliée sans appel, app.slice rendue à son origine', async () => {
    const w = world({ protectedChain: true });
    const d = w.make();
    d.tick(w.input(true));
    await d.idle();
    w.sys.delete(WARP);
    w.calls.length = 0;
    d.tick(w.input(true, []));
    await d.idle();
    expect(w.calls).toEqual([{ unit: 'app.slice', props: { MemoryLow: '0', CPUWeight: INFINITY_T } }]);
    expect(Object.keys(w.saved.at(-1)!).sort()).toEqual(['cwatch.slice', 'session.slice']);
  });

  test('valeur qui ne prend pas : un seul appel, nouvel essai après le recul', async () => {
    const w = world({ inert: true });
    const d = w.make();
    d.tick(w.input(true));
    await d.idle();
    for (let k = 0; k < 10; k++) d.tick(w.input(true));
    await d.idle();
    expect(w.calls).toHaveLength(3);
    w.advance(DESK_RETRY_MS);
    d.tick(w.input(true));
    await d.idle();
    expect(w.calls).toHaveLength(6);
  });

  test('refus du gestionnaire : indisponible 5 min, aucun appel pendant ce temps', async () => {
    const w = world({ fail: () => new BusctlError('Access denied', 'denied') });
    const d = w.make();
    d.tick(w.input(true));
    await d.idle();
    expect(w.calls).toHaveLength(1);
    d.tick(w.input(true));
    await d.idle();
    expect(w.calls).toHaveLength(1);
    expect(d.state()).toMatchObject({ status: 'unavailable' });
    expect(w.logs.some((l) => l.includes('Access denied'))).toBe(true);
  });

  test('service disparu entre la lecture et l’appel (no-unit) : origines oubliées', async () => {
    const w = world({ protectedChain: true, fail: (u) => (u === WARP_UNIT ? new BusctlError(`Unit ${u} not loaded.`, 'no-unit') : null) });
    const d = w.make();
    d.tick(w.input(true));
    await d.idle();
    expect(w.saved.at(-1)![WARP_UNIT]).toBeUndefined();
    expect(w.saved.at(-1)!['session.slice']).toBeDefined();
  });

  test('slice disparue avec des origines : restaurée quand même (elle reprendrait nos valeurs runtime)', async () => {
    const w = world();
    w.sys.delete(APP);
    const d = w.make({ 'app.slice': { cgroup: APP, cpuWeight: null } });
    d.tick(w.input(false));
    await d.idle();
    expect(w.calls).toEqual([{ unit: 'app.slice', props: { CPUWeight: INFINITY_T } }]);
  });

  test('origines pleines : jamais une valeur posée sans origine gardée', async () => {
    const w = world();
    const full: DeskOriginals = {};
    for (let k = 0; k < MAX_ORIGINALS; k++) full[`app-x${k}.slice`] = { cgroup: `${BASE}/app-x${k}.slice`, cpuWeight: null };
    for (let k = 0; k < MAX_ORIGINALS; k++) w.sys.set(`${BASE}/app-x${k}.slice`, { 'cgroup.controllers': 'memory', 'cpu.weight': '100' });
    const d = w.make(full);
    d.tick(w.input(true));
    await d.idle();
    expect(w.calls.filter((c) => !c.unit.startsWith('app-x'))).toEqual([]);
  });

  test('origines relues filtrées : noms, cgroups et valeurs invalides ignorés', () => {
    expect(sanitizeOriginals({
      'session.slice': { cgroup: SESSION, cpuWeight: null, memoryLow: 0 },
      'cwatch.slice': { cgroup: ROOT, memoryLow: 5 },
      'cwatch-p-a.slice': { cgroup: `${BASE}/cwatch.slice/cwatch-p.slice/cwatch-p-a.slice`, cpuWeight: 1 },
      'app.slice': { cgroup: `${BASE}/../app.slice`, cpuWeight: 1 },
      'b.slice': { cgroup: `${BASE}/other.slice`, cpuWeight: 1 },
      'c.slice': { cgroup: `${BASE}/c.slice`, cpuWeight: 0 },
      'd.slice': { cgroup: `${BASE}/d.slice`, ioWeight: 20_000 },
      'e.slice': 'x',
    })).toEqual({ 'session.slice': { cgroup: SESSION, cpuWeight: null, memoryLow: 0 } });
    expect(sanitizeOriginals([1])).toEqual({});
    expect(sanitizeOriginals(null)).toEqual({});
  });
});
