// Frigo (anti-gel lot 3) dans le service : faux /proc, faux client systemd (fakeSystemd), faux frigo (FreezeUnit simulé
// sur un faux sysfs). Aucun appel D-Bus réel, aucun vrai processus gelé.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { readCgroup, reverify } from '../core/antigel/cgroupfs';
import { writeFridgeRequest } from '../core/antigel/fridgeRequest';
import { freezeArgv, liftSwapArgv, thawArgv, type FridgeClient } from '../core/antigel/fridgeSystemd';
import { fakeSystemd } from '../core/antigel/testFixtures';
import { addProc, makeProcRoot } from '../core/collector/fakeProc';
import { DEFAULT_CONFIG } from '../core/config';
import { createRecorder } from './recorder';

const BASE = '/user.slice/user-1000.slice/user@1000.service';
const WARP = `${BASE}/app.slice/app-dev.warp.Warp@1.service`;
const PS = 'cwatch-p-alpha.slice';
const PSCG = `${BASE}/cwatch.slice/cwatch-p.slice/${PS}`;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  mkdirSync(join(homedir(), '.cache'), { recursive: true });
  const base = mkdtempSync(join(homedir(), '.cache', 'pw-fridge-rec-'));
  dirs.push(base);
  const A = join(base, 'alpha');
  mkdirSync(A);
  writeFileSync(join(A, 'package.json'), '{}');
  const NM = `${A}/node_modules`;
  const procRoot = makeProcRoot(100_000);
  dirs.push(procRoot);
  writeFileSync(join(procRoot, 'meminfo'), 'MemTotal: 16777216 kB\nMemAvailable: 8000000 kB\nSwapTotal: 8388608 kB\nSwapFree: 8388608 kB\n');
  writeFileSync(join(procRoot, 'loadavg'), '1.00 1.00 1.00 1/100 999\n');
  addProc(procRoot, { pid: 500, comm: 'systemd', ppid: 1, rssKB: 10_000, cmdline: ['systemd', '--user'], cgroup: `${BASE}/init.scope` });
  addProc(procRoot, { pid: 900, comm: 'node', ppid: 500, rssKB: 50_000, cmdline: ['node', '/x/out/main/recorder.js'], cgroup: `${BASE}/app.slice/r.service` });
  addProc(procRoot, { pid: 600, comm: 'warp', ppid: 500, rssKB: 300_000, cmdline: ['warp'], cgroup: WARP });
  addProc(procRoot, { pid: 601, comm: 'zsh', ppid: 600, rssKB: 5_000, cmdline: ['zsh'], cwd: A, cgroup: WARP });
  addProc(procRoot, { pid: 700, comm: 'MainThread', ppid: 601, starttime: 7000, rssKB: 300_000, cwd: A, cmdline: ['node', `${NM}/jest/bin/jest.js`], cgroup: WARP });
  addProc(procRoot, { pid: 701, comm: 'MainThread', ppid: 700, starttime: 7010, rssKB: 900_000, cwd: A, cmdline: ['node', `${NM}/jest-worker/build/workers/processChild.js`], cgroup: WARP });
  const cfgDir = join(base, 'cfg');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({
    ...DEFAULT_CONFIG, recorder: { ...DEFAULT_CONFIG.recorder, intervalSec: 5 }, classify: { detectPorts: false, overrides: {} }, rules: { enabled: false, list: [] },
    antigel: { enabled: true, reserveMB: null, budgets: {} },
  }));
  const fake = fakeSystemd({ userBase: BASE });
  // faux frigo : cgroup.freeze par slice, scopes et pids repris du faux client systemd
  const frozen = new Set<string>();
  const fcalls: string[] = [];
  const client: FridgeClient = {
    freeze: async (s) => { freezeArgv(s); fcalls.push(`freeze ${s}`); frozen.add(`${BASE}/cwatch.slice/cwatch-p.slice/${s}`); },
    thaw: async (s) => { thawArgv(s); fcalls.push(`thaw ${s}`); frozen.delete(`${BASE}/cwatch.slice/cwatch-p.slice/${s}`); },
    liftSwap: async (s) => { liftSwapArgv(s); fcalls.push(`liftSwap ${s}`); },
    thawSync: (s) => { thawArgv(s); fcalls.push(`thawSync ${s}`); frozen.delete(`${BASE}/cwatch.slice/cwatch-p.slice/${s}`); },
    calls: () => fcalls.length,
  };
  const scopesOf = (cg: string) => [...new Set([...fake.cg.values()].filter((c) => c.startsWith(`${cg}/`)).map((c) => c.slice(cg.length + 1)))];
  const dataDir = join(base, 'data');
  let t = 10_000_000;
  let mono = 0;
  const logs: string[] = [];
  const rec = createRecorder({
    dataDir, configDir: cfgDir, procRoot, now: () => t, cpuCount: 4, log: (m) => logs.push(m), selfPid: 900, currentUid: 1000, appRoot: null, monoNow: () => mono,
    antigel: {
      client: fake.client, probe: () => ({ ok: true, userBase: BASE, busctl: '/usr/bin/busctl' }), stats: (p) => fake.sys.get(p) ?? null,
      cgroupOf: (pid) => fake.cg.get(pid) ?? readCgroup(procRoot, pid), reverify: (x, cg) => reverify(procRoot, 1000, x, cg),
    },
    fridge: {
      client, probe: () => ({ ok: true, userBase: BASE, busctl: '/usr/bin/busctl' }),
      read: (cg, f) => {
        if (!fake.sys.has(cg) && !frozen.has(cg) && !cg.includes('.scope')) return null;
        if (f === 'cgroup.freeze') return frozen.has(cg) ? '1\n' : '0\n';
        if (f === 'cgroup.events') return `populated 1\nfrozen ${frozen.has(cg) ? 1 : 0}\n`;
        if (f === 'memory.current') return String(fake.sys.get(cg)?.currentBytes ?? 0);
        if (f === 'memory.stat') return 'anon 0\nfile 0\n';
        if (f === 'cgroup.procs') return [...fake.cg].filter(([, c]) => c === cg).map(([p]) => p).join('\n');
        return null;
      },
      list: (cg) => (cg === `${BASE}/cwatch.slice/cwatch-p.slice` ? [PS] : scopesOf(cg)),
      reclaim: async () => 'ok',
    },
  });
  const tick = async () => {
    t += 5000;
    mono += 5000;
    rec.tick();
    await rec.antigelIdle();
  };
  return { rec, tick, fcalls, frozen, dataDir, A, logs, procRoot, now: () => t, statePath: join(dataDir, 'antigel-state.json') };
}

test('demande de la fenêtre → projet au frigo, état publié ; réveil ; arrêt du service : rien ne reste gelé', async () => {
  const s = setup();
  s.rec.start();
  await s.tick(); // jest et son worker rangés dans la slice du projet
  writeFridgeRequest(s.dataDir, { root: s.A, action: 'freeze', at: s.now() });
  await s.tick();
  expect(s.fcalls).toEqual([`freeze ${PS}`]);
  await s.tick();
  const st = JSON.parse(readFileSync(s.statePath, 'utf8'));
  expect(st.fridge).toEqual([{ unit: PS, root: s.A, since: expect.any(Number), phase: 'frozen', reclaimedKB: 0 }]);
  expect(st.fridgeNotice).toMatchObject({ root: s.A, ok: true });
  writeFridgeRequest(s.dataDir, { root: s.A, action: 'thaw', at: s.now() });
  await s.tick();
  expect(s.fcalls).toEqual([`freeze ${PS}`, `thaw ${PS}`]);
  writeFridgeRequest(s.dataDir, { root: s.A, action: 'freeze', at: s.now() });
  await s.tick();
  expect(s.frozen.has(PSCG)).toBe(true);
  s.rec.stop();
  expect(s.fcalls.at(-1)).toBe(`thawSync ${PS}`);
  expect(s.frozen.size).toBe(0);
});

test('demande d’un projet hors plafond ou d’une racine inconnue : refusée par le service, rien n’est gelé', async () => {
  const s = setup();
  s.rec.start();
  await s.tick();
  writeFridgeRequest(s.dataDir, { root: '/home/u/ailleurs', action: 'freeze', at: s.now() });
  await s.tick();
  expect(s.fcalls).toEqual([]);
  expect(JSON.parse(readFileSync(s.statePath, 'utf8')).fridgeNotice).toMatchObject({ root: '/home/u/ailleurs', ok: false });
  s.rec.stop();
});

test('démarrage : slice de projet restée gelée dégelée avant tout ; échantillonnage en échec : le réveil passe quand même', async () => {
  const s = setup();
  s.frozen.add(PSCG); // gelée par une vie précédente du service
  s.rec.start();
  expect(s.fcalls).toEqual([`thawSync ${PS}`]);
  await s.tick();
  writeFridgeRequest(s.dataDir, { root: s.A, action: 'freeze', at: s.now() });
  await s.tick();
  expect(s.frozen.has(PSCG)).toBe(true);
  // /proc/meminfo illisible : l'échantillonnage du tick échoue
  rmSync(join(s.procRoot, 'meminfo'));
  writeFridgeRequest(s.dataDir, { root: s.A, action: 'thaw', at: s.now() });
  await s.tick();
  expect(s.logs.some((l) => /tick/.test(l))).toBe(true);
  expect(s.frozen.has(PSCG)).toBe(false);
  s.rec.stop();
});
