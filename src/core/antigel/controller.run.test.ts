// Contrôleur et scopes ouverts par `computer-watcher run` (lot 4) : jamais redéplacés, comptés, slice attribuée.
import { describe, expect, test } from 'vitest';
import { buildGroups } from '../grouping/buildGroups';
import type { ProcInfo, SystemInfo } from '../types';
import type { AntigelConfig } from './config';
import { createAntigel } from './controller';
import type { RunScopeDeps } from './runScopes';
import { fakeSystemd, sampleStats } from './testFixtures';
import { hashedProjectSlice } from './run';
import { shortHash } from './units';

const BASE = '/user.slice/user-1000.slice/user@1000.service';
const WARP = `${BASE}/app.slice/app-dev.warp.Warp@1.service`;
const PARENT = `${BASE}/cwatch.slice/cwatch-p.slice`;
const A = '/home/u/alpha';
const PS = 'cwatch-p-alpha.slice';
const PSCG = `${PARENT}/${PS}`;
const RUN = 'cwatch-p-alpha-r0000000001.scope';
const ON: AntigelConfig = { enabled: true, reserveMB: null, budgets: {} };
// RAM entièrement disponible : le plafond dynamique vaut le plafond statique (12 Go), sauf dans les tests qui le font varier.
const SYS: SystemInfo = { memTotalKB: 16 * 1024 * 1024, memAvailableKB: 16 * 1024 * 1024, swapTotalKB: 8 * 1024 * 1024, swapFreeKB: 8 * 1024 * 1024, load1: 1, psiSome10: null, shmemKB: null };

let stc = 1;
const p = (pid: number, ppid: number, name: string, cmdline: string, cwd: string | null = null, ageSec = 60): ProcInfo => ({
  pid, ppid, name, cmdline, uid: 1000, startTicks: stc++, ageSec, cpuTicks: 0, cpuPercent: 0, rssKB: 100_000, swapKB: 0, cwd, cwdDeleted: false,
});

function harness(o: { procs: ProcInfo[]; cg: Record<number, string>; dirs: Record<string, string[]>; cwds?: Record<number, string>; config?: AntigelConfig; noRun?: boolean }) {
  const fake = fakeSystemd({ userBase: BASE });
  for (const [pid, c] of Object.entries(o.cg)) fake.cg.set(Number(pid), c);
  for (const dir of Object.keys(o.dirs)) if (dir.endsWith('.slice')) fake.sys.set(dir, sampleStats());
  const reads = { list: 0, procs: 0, cwd: 0 };
  const run: RunScopeDeps = {
    listDir: (cg) => {
      reads.list++;
      return o.dirs[cg] ?? null;
    },
    procsOf: (cg) => {
      reads.procs++;
      const scope = cg.split('/').pop()!;
      return [...fake.cg].filter(([, c]) => c.endsWith(`/${scope}`)).map(([pid]) => pid);
    },
    cwdOf: (pid) => {
      reads.cwd++;
      return o.cwds?.[pid] ?? null;
    },
  };
  const ag = createAntigel({
    client: fake.client, probe: () => ({ ok: true, userBase: BASE, busctl: '/usr/bin/busctl' }), reverify: (t) => [...t], log: () => {}, monoNow: () => mono,
    perfNow: () => 0, stats: (path) => fake.sys.get(path) ?? null, cgroupOf: (pid) => fake.cg.get(pid) ?? WARP, run: o.noRun ? undefined : run,
  });
  const rootOf = (c: string) => (c === A || c.startsWith(`${A}/`) ? A : c.startsWith('/home/u/b/alpha') ? '/home/u/b/alpha' : null);
  let mono = 0;
  const step = async () => {
    mono += 5000;
    ag.tick({
      ts: 1_000_000 + mono, procs: o.procs, system: SYS, config: o.config ?? ON, currentUid: 1000, selfPid: 900, appRoot: null, home: '/home/u',
      isProtected: (n: string) => ['zsh', 'warp'].includes(n), projectRootOf: rootOf,
      groups: buildGroups(o.procs, { home: '/home/u', currentUid: 1000, isProtected: () => false, othersThreshold: { memMB: 0, cpuPercent: 0 }, projectRootOf: rootOf }),
    });
    await ag.idle();
  };
  return { ag, fake, step, reads };
}

const scopeCg = (slice: string, scope: string) => `${PARENT}/${slice}/${scope}`;
const HS = hashedProjectSlice(A);
const HRUN = `${HS.slice(0, -'.slice'.length)}-r0000000001.scope`;

describe('scopes « run » vus par le contrôleur', () => {
  test('commande quelconque lancée par run : jamais redéplacée, slice attribuée par son dossier courant, processus comptés, budget posé', async () => {
    // warp → zsh → tail (le lanceur devenu la commande) → sleep, dans le scope « run » ; aucun n'est du « travail »
    const procs = [p(600, 500, 'warp', 'warp'), p(601, 600, 'zsh', 'zsh', A), p(800, 601, 'tail', 'tail -f /dev/null'), p(801, 800, 'sleep', 'sleep 60')];
    const h = harness({
      procs, cg: { 800: scopeCg(HS, HRUN), 801: scopeCg(HS, HRUN) }, cwds: { 800: `${A}/src` },
      dirs: { [PARENT]: [HS, 'cgroup.procs', 'memory.current'], [`${PARENT}/${HS}`]: [HRUN, 'memory.current'] },
      config: { ...ON, budgets: { [A]: 2048 } },
    });
    await h.step();
    expect(h.fake.calls.map((c) => c[0])).toEqual(['ensureSlice', 'setProjectHigh']);
    expect(h.fake.calls[1]).toEqual(['setProjectHigh', HS, 2048 * 1024 * 1024]);
    expect(h.ag.state()).toMatchObject({ slices: { [HS]: A }, projects: [{ unit: HS, root: A, procs: 2, budgetMB: 2048 }] });
    // ensuite : rien de plus, ni déplacement ni nouvelle lecture de dossier courant
    h.fake.calls.length = 0;
    const cwdReads = h.reads.cwd;
    await h.step();
    expect(h.fake.calls).toEqual([]);
    expect(h.reads.cwd).toBe(cwdReads);
  });

  test('travail lancé par run (npm test) : refusé « déjà rangé », compté une seule fois avec le travail déplacé par le contrôleur', async () => {
    const NM = `${A}/node_modules`;
    const procs = [
      p(600, 500, 'warp', 'warp'), p(601, 600, 'zsh', 'zsh', A),
      p(800, 601, 'npm run test', 'npm run test', A), p(801, 800, 'MainThread', `node ${NM}/jest/bin/jest.js`, A),
      p(700, 601, 'MainThread', `node ${NM}/vitest/vitest.mjs run`, A),
    ];
    const lot1 = 'cwatch-p-alpha-mgz1abcd0001.scope';
    const h = harness({
      procs, cg: { 800: scopeCg(PS, RUN), 801: scopeCg(PS, RUN), 700: scopeCg(PS, lot1) },
      dirs: { [PARENT]: [PS], [PSCG]: [RUN, lot1] },
    });
    await h.step();
    expect(h.fake.calls.filter((c) => c[0] === 'startScope')).toEqual([]);
    expect(h.ag.state().projects).toMatchObject([{ unit: PS, root: A, procs: 3 }]);
  });

  test('« autres » : attribuée à null directement ; slice inconnue sans scope « run » : jamais attribuée (attribution perdue, lot 1)', async () => {
    const OTHERS = 'cwatch-p-autres.slice';
    const procs = [p(600, 500, 'warp', 'warp'), p(601, 600, 'zsh', 'zsh', '/tmp'), p(800, 601, 'tail', 'tail -f /dev/null'), p(810, 1, 'node', 'node x.js')];
    const h = harness({
      procs, cg: { 800: scopeCg(OTHERS, 'cwatch-p-autres-r0000000002.scope'), 810: scopeCg(PS, 'cwatch-p-alpha-mgz1abcd0001.scope') },
      cwds: { 810: A },
      dirs: { [PARENT]: [OTHERS, PS], [`${PARENT}/${OTHERS}`]: ['cwatch-p-autres-r0000000002.scope'], [PSCG]: ['cwatch-p-alpha-mgz1abcd0001.scope'] },
    });
    await h.step();
    expect(h.ag.state().slices).toEqual({ [OTHERS]: null });
    expect(h.ag.state().projects).toMatchObject([{ unit: OTHERS, root: null, procs: 1 }]);
    // la slice orpheline n'est pas réexaminée à chaque tick (recul)
    const lists = h.reads.list;
    await h.step();
    expect(h.reads.list - lists).toBeLessThanOrEqual(2); // cwatch-p.slice + « autres » (décompte), pas la slice orpheline
  });

  test('dossier courant d’une autre racine que celle du nom : pas d’attribution (jamais le budget d’un projet sur la slice d’un autre)', async () => {
    const hashed = `cwatch-p-alpha_${shortHash('/home/u/b/alpha')}.slice`;
    const procs = [p(600, 500, 'warp', 'warp'), p(601, 600, 'zsh', 'zsh'), p(800, 601, 'tail', 'tail -f /dev/null')];
    const run = `cwatch-p-alpha_${shortHash('/home/u/b/alpha')}-r0000000003.scope`;
    // nom haché de /home/u/b/alpha, mais le processus est dans /home/u/alpha
    const h = harness({
      procs, cg: { 800: scopeCg(hashed, run) }, cwds: { 800: A },
      dirs: { [PARENT]: [hashed], [`${PARENT}/${hashed}`]: [run] },
    });
    await h.step();
    expect(h.ag.state().slices).toEqual({});
    const ok = harness({
      procs, cg: { 800: scopeCg(hashed, run) }, cwds: { 800: '/home/u/b/alpha/web' },
      dirs: { [PARENT]: [hashed], [`${PARENT}/${hashed}`]: [run] },
    });
    await ok.step();
    expect(ok.ag.state().slices).toEqual({ [hashed]: '/home/u/b/alpha' });
  });

  test('nom simple non attribué avec un scope « run » : jamais attribué (run ne l’ouvre jamais ; même slug, autre racine possible)', async () => {
    const procs = [p(600, 500, 'warp', 'warp'), p(601, 600, 'zsh', 'zsh'), p(800, 601, 'tail', 'tail -f /dev/null')];
    const h = harness({ procs, cg: { 800: scopeCg(PS, RUN) }, cwds: { 800: A }, dirs: { [PARENT]: [PS], [PSCG]: [RUN] } });
    await h.step();
    expect(h.ag.state().slices).toEqual({});
  });

  test('processus « run » pas encore dans l’instantané : réexaminée au tick suivant, sans recul (revue m4)', async () => {
    const procs = [p(600, 500, 'warp', 'warp'), p(601, 600, 'zsh', 'zsh', A)];
    const h = harness({ procs, cg: { 800: scopeCg(HS, HRUN) }, cwds: { 800: A }, dirs: { [PARENT]: [HS], [`${PARENT}/${HS}`]: [HRUN] } });
    await h.step();
    expect(h.ag.state().slices).toEqual({});
    procs.push(p(800, 601, 'tail', 'tail -f /dev/null'));
    await h.step();
    expect(h.ag.state().slices).toEqual({ [HS]: A });
  });

  test('sans dépendances « run » : comportement du lot 1 inchangé', async () => {
    const procs = [p(600, 500, 'warp', 'warp'), p(601, 600, 'zsh', 'zsh', A), p(800, 601, 'tail', 'tail -f /dev/null')];
    const h = harness({ procs, cg: { 800: scopeCg(PS, RUN) }, cwds: { 800: A }, dirs: { [PARENT]: [PS], [PSCG]: [RUN] }, noRun: true });
    await h.step();
    expect(h.ag.state().slices).toEqual({});
    expect(h.reads.list).toBe(0);
  });
});
