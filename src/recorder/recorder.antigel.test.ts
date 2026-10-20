// Anti-gel dans le service : faux /proc (avec cgroups), faux sysfs et faux client systemd (fakeSystemd : aucun busctl).
// Aucun appel D-Bus réel, aucun vrai processus déplacé.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import { readCgroup, reverify, type CgroupStats } from '../core/antigel/cgroupfs';
import { GiB, MiB } from '../core/antigel/limits';
import { fakeSystemd, sampleStats as stats, type FakeSystemd } from '../core/antigel/testFixtures';
import { addProc, makeProcRoot } from '../core/collector/fakeProc';
import { DEFAULT_CONFIG } from '../core/config';
import { createRecorder, type RecorderDeps } from './recorder';

const BASE = '/user.slice/user-1000.slice/user@1000.service';
const WARP = `${BASE}/app.slice/app-dev.warp.Warp@1.service`;
const PS = 'cwatch-p-alpha.slice';
const PSCG = `${BASE}/cwatch.slice/cwatch-p.slice/${PS}`;
const SCOPE = /^cwatch-p-alpha-[a-z0-9]{1,12}\.scope$/;
const ROOT_CALL = ['ensureSlice', 'cwatch.slice', 12 * GiB, 14 * GiB, 4 * GiB];
const ev = (o: Partial<CgroupStats['events']> = {}) => ({ high: 0, max: 0, oom: 0, oomKill: 0, ...o });

afterEach(() => {
  vi.unstubAllEnvs();
});

function setup(o: { withDeps?: boolean; antigel?: object; throwStats?: { on: boolean }; extra?: (procRoot: string, A: string) => void } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'pw-antigel-rec-'));
  // racine de projet réelle (package.json) dans le dossier temporaire : groupe « project:<A> »
  const A = join(base, 'alpha');
  mkdirSync(A);
  writeFileSync(join(A, 'package.json'), '{}');
  const NM = `${A}/node_modules`;
  const procRoot = makeProcRoot(100_000);
  writeFileSync(join(procRoot, 'meminfo'), 'MemTotal: 16777216 kB\nMemAvailable: 8000000 kB\nSwapTotal: 8388608 kB\nSwapFree: 8388608 kB\n');
  writeFileSync(join(procRoot, 'loadavg'), '1.00 1.00 1.00 1/100 999\n');
  addProc(procRoot, { pid: 500, comm: 'systemd', ppid: 1, rssKB: 10_000, cmdline: ['systemd', '--user'], cgroup: `${BASE}/init.scope` });
  addProc(procRoot, { pid: 900, comm: 'node', ppid: 500, rssKB: 50_000, cmdline: ['node', '/x/out/main/recorder.js'], cgroup: `${BASE}/app.slice/r.service` });
  addProc(procRoot, { pid: 600, comm: 'warp', ppid: 500, rssKB: 300_000, cmdline: ['warp'], cgroup: WARP });
  addProc(procRoot, { pid: 601, comm: 'zsh', ppid: 600, rssKB: 5_000, cmdline: ['zsh'], cwd: A, cgroup: WARP });
  addProc(procRoot, { pid: 700, comm: 'MainThread', ppid: 601, starttime: 7000, rssKB: 300_000, cwd: A, cmdline: ['node', `${NM}/jest/bin/jest.js`], cgroup: WARP });
  addProc(procRoot, { pid: 701, comm: 'MainThread', ppid: 700, starttime: 7010, rssKB: 900_000, cwd: A, cmdline: ['node', `${NM}/jest-worker/build/workers/processChild.js`], cgroup: WARP });
  o.extra?.(procRoot, A);
  const cfgDir = join(base, 'cfg');
  mkdirSync(cfgDir, { recursive: true });
  const writeCfg = (antigel: object) =>
    writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ ...DEFAULT_CONFIG, recorder: { ...DEFAULT_CONFIG.recorder, intervalSec: 5 }, classify: { detectPorts: false, overrides: {} }, rules: { enabled: false, list: [] }, antigel }));
  writeCfg(o.antigel ?? { enabled: true, reserveMB: null, budgets: {} });
  const fake = fakeSystemd({ userBase: BASE });
  const antigelFor = (f: FakeSystemd): RecorderDeps['antigel'] => ({
    client: f.client,
    probe: () => ({ ok: true, userBase: BASE, busctl: '/usr/bin/busctl' }),
    stats: (path) => {
      if (o.throwStats?.on) throw new Error('sysfs illisible');
      return f.sys.get(path) ?? null;
    },
    // processus déplacés par le faux client : leur nouveau cgroup ; sinon celui du faux /proc
    cgroupOf: (pid) => f.cg.get(pid) ?? readCgroup(procRoot, pid),
    reverify: (t, cg) => reverify(procRoot, 1000, t, cg),
  });
  let t = 10_000_000;
  let mono = 0;
  const dataDir = join(base, 'data');
  const logs: string[] = [];
  const recorder = (f: FakeSystemd | null) =>
    createRecorder({
      dataDir, configDir: cfgDir, procRoot, now: () => t, cpuCount: 4, log: (m) => logs.push(m), selfPid: 900, currentUid: 1000, appRoot: null,
      monoNow: () => mono, ...(f ? { antigel: antigelFor(f) } : {}),
    });
  const rec = recorder(o.withDeps === false ? null : fake);
  const tick = async () => {
    t += 5000;
    mono += 5000;
    rec.tick();
    await rec.antigelIdle();
  };
  const events = () => {
    const db = new DatabaseSync(join(dataDir, 'metrics.db'), { readOnly: true });
    const rows = (db.prepare("SELECT g.key AS key, e.detail AS detail FROM events e LEFT JOIN groups g ON g.id = e.group_id WHERE e.type = 'antigel_oom'").all() as { key: string | null; detail: string }[])
      .map((e) => ({ groupKey: e.key, ...JSON.parse(e.detail) }));
    db.close();
    return rows;
  };
  const statePath = join(dataDir, 'antigel-state.json');
  return { rec, recorder, tick, calls: fake.calls, sys: fake.sys, cg: fake.cg, dataDir, procRoot, statePath, events, writeCfg, logs, A };
}

test('service : cwatch.slice plafonnée, slice du projet, jest et son worker dans un scope neuf ; état écrit (0600)', async () => {
  const s = setup();
  s.rec.start();
  await s.tick();
  expect(s.calls).toEqual([ROOT_CALL, ['ensureProjectSlice', PS, null], ['startScope', expect.stringMatching(SCOPE), PS, [700, 701]]]);
  expect(s.cg.get(701)).toMatch(new RegExp(`^${PSCG}/cwatch-p-alpha-[a-z0-9]+\\.scope$`));
  await s.tick();
  await s.tick();
  expect(s.calls).toHaveLength(3); // régime établi : aucun appel
  expect(JSON.parse(readFileSync(s.statePath, 'utf8'))).toMatchObject({
    version: 1, status: 'active', enabled: true, projects: [{ unit: PS, root: s.A, procs: 2 }], scopes: { [PS]: s.A }, dbusCalls: 3, lastError: null,
  });
  expect(statSync(s.statePath).mode & 0o777).toBe(0o600);
  s.rec.stop();
});

test('redémarrage du service : attribution relue dans antigel-state.json, plafonds reposés, aucun scope ni slice de projet', async () => {
  const s = setup();
  s.rec.start();
  await s.tick();
  s.rec.stop();
  // processus terminés entre-temps : seule la relecture de l'état peut redonner l'attribution
  rmSync(join(s.procRoot, '700'), { recursive: true });
  rmSync(join(s.procRoot, '701'), { recursive: true });
  const fake2 = fakeSystemd({ userBase: BASE });
  fake2.sys.set(PSCG, stats());
  const rec2 = s.recorder(fake2);
  rec2.start();
  rec2.tick();
  await rec2.antigelIdle();
  expect(fake2.calls).toEqual([ROOT_CALL]);
  expect(JSON.parse(readFileSync(s.statePath, 'utf8'))).toMatchObject({ scopes: { [PS]: s.A }, projects: [{ unit: PS, root: s.A }] });
  rec2.stop();
});

test('budget du projet : posé à la création de sa slice ; interrupteur éteint (config rechargée) : tout remis à infinity', async () => {
  const s = setup({ antigel: { enabled: true, reserveMB: null, budgets: {} } });
  s.writeCfg({ enabled: true, reserveMB: null, budgets: { [s.A]: 1024 } });
  s.rec.reloadConfig();
  s.rec.start();
  await s.tick();
  expect(s.calls[1]).toEqual(['ensureProjectSlice', PS, 1024 * MiB]);
  s.calls.length = 0;
  s.writeCfg({ enabled: false, reserveMB: null, budgets: { [s.A]: 1024 } });
  s.rec.reloadConfig();
  await s.tick();
  expect(s.calls).toEqual([['setSlice', 'cwatch.slice', null], ['setProjectHigh', PS, null]]);
  expect(JSON.parse(readFileSync(s.statePath, 'utf8'))).toMatchObject({ status: 'off', enabled: false });
  s.rec.stop();
});

test('OOM dans la slice du projet : événement d’historique antigel_oom (groupe du projet)', async () => {
  const s = setup();
  s.rec.start();
  await s.tick(); // slice et scope créés
  s.sys.set(PSCG, stats({ events: ev({ high: 1, oom: 1, oomKill: 1 }) }));
  await s.tick(); // première lecture : référence, aucun événement
  expect(s.events()).toEqual([]);
  s.sys.set(PSCG, stats({ events: ev({ high: 3, oom: 2, oomKill: 2 }) }));
  await s.tick(); // +1 OOM
  expect(s.events()).toEqual([{ groupKey: `project:${s.A}`, unit: PS, root: s.A, kills: 1 }]);
  s.rec.stop();
});

test('dossiers de config de Claude du service transmis à l’anti-gel : le travail lancé par l’outil Bash est rangé', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-claude-cfg-'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', dir);
  const s = setup({
    extra: (procRoot, A) => {
      addProc(procRoot, { pid: 800, comm: 'claude', ppid: 601, rssKB: 400_000, cmdline: ['claude'], cwd: A, cgroup: WARP });
      addProc(procRoot, { pid: 801, comm: 'zsh', ppid: 800, rssKB: 5_000, cmdline: ['/bin/zsh', '-c', `source ${dir}/shell-snapshots/s.sh && tsc --noEmit`], cwd: '/', cgroup: WARP });
      addProc(procRoot, { pid: 810, comm: 'MainThread', ppid: 801, starttime: 8100, rssKB: 900_000, cwd: '/', cmdline: ['node', '/usr/lib/node_modules/typescript/bin/tsc', '--noEmit'], cgroup: WARP });
    },
  });
  s.rec.start();
  await s.tick();
  expect(s.calls).toContainEqual(['startScope', expect.stringMatching(/^cwatch-p-autres-[a-z0-9]+\.scope$/), 'cwatch-p-autres.slice', [810]]);
  s.rec.stop();
});

test('sans dépendances anti-gel (tests, PROC_WATCH_NO_ANTIGEL=1) : aucun appel, aucun fichier d’état', async () => {
  const s = setup({ withDeps: false });
  s.rec.start();
  await s.tick();
  await s.tick();
  expect(s.calls).toEqual([]);
  expect(existsSync(s.statePath)).toBe(false);
  expect(s.rec.status().lastSampleAt).not.toBeNull();
  s.rec.stop();
});

test('erreur dans l’anti-gel : jobErrors.antigel, l’échantillonnage continue, puis l’erreur s’efface', async () => {
  const sysfs = { on: true };
  const s = setup({ throwStats: sysfs });
  s.rec.start();
  await s.tick();
  expect(s.rec.status().jobErrors?.antigel).toBe('Plafond de travail: sysfs illisible');
  expect(s.rec.status().lastError).toBe('Plafond de travail: sysfs illisible');
  expect(s.rec.status().lastSampleAt).not.toBeNull();
  expect(s.calls).toEqual([]);
  expect(existsSync(s.statePath)).toBe(false);
  sysfs.on = false;
  await s.tick();
  expect(s.rec.status().jobErrors?.antigel).toBeNull();
  expect(s.rec.status().lastError).toBeNull();
  expect(existsSync(s.statePath)).toBe(true);
  s.rec.stop();
});

test('le service arrêté puis relancé ne garde pas l’orchestrateur : antigelIdle se résout', async () => {
  const s = setup();
  s.rec.start();
  await s.tick();
  s.rec.stop();
  await expect(s.rec.antigelIdle()).resolves.toBeUndefined();
});
