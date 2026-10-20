// Bureau prioritaire (anti-gel, lot 2), e2e RÉEL (`npm run test:antigel`, PROC_WATCH_ANTIGEL_E2E=1) : le vrai orchestrateur
// et le vrai busctl sur le vrai gestionnaire systemd utilisateur, mais SEULEMENT sur des unités de test. Les unités du
// bureau (session.slice, app.slice, unité d'un terminal, cwatch.slice) y sont VIRTUELLES : un pont propre au test
// traduit chaque nom et chaque chemin de cgroup vers une unité cwatch-e2e… et refuse tout le reste.
//   cwatch.slice/cwatch-e2e<id>.slice                 « cwatch.slice » (poids 50)
//     ├ cwatch-e2e<id>-s.slice                        « session.slice » (poids 200, protection)
//     │ └ cwatch-e2e<id>-2.scope                      tail (peuple la slice)
//     └ cwatch-e2e<id>-a.slice                        « app.slice » (poids 150, protection)
//       └ cwatch-e2e<id>-1.scope                      « unité du terminal » : tail (protection)
// Une seconde partie lit seulement le vrai sysfs : ce que le bureau prioritaire ferait ici, sans aucun appel.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { readDeskFile } from '../../recorder/antigelDeps';
import { systemBin } from '../childEnv';
import type { ProcInfo } from '../types';
import { probeAvailability, readCgroup } from './cgroupfs';
import { createDeskPriority, type DeskOriginals } from './desk';
import { createDeskClient, type DeskClient } from './deskSystemd';
import { MiB } from './limits';
import { BusctlError, createBusctl, createSystemdClient } from './systemd';
import { isTestUnitName, scopePath, slicePath } from './units';

const RUN = process.env.PROC_WATCH_ANTIGEL_E2E === '1';
const SYSFS = '/sys/fs/cgroup';
const R = 64 * MiB;

const wait = async (fn: () => boolean, ms: number, what: string) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`délai dépassé : ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const alive = (k: ChildProcess) => k.exitCode === null && k.signalCode === null;
const proc = (pid: number, name: string): ProcInfo => ({
  pid, ppid: 1, name, cmdline: name, uid: process.getuid!(), startTicks: 1, ageSec: 100, cpuTicks: 0, cpuPercent: 0, rssKB: 1, swapKB: 0, cwd: null, cwdDeleted: false,
});

test.skipIf(!RUN)(
  'bureau prioritaire sur des unités de test : poids et protection posés, régime établi sans appel, origines restaurées',
  async () => {
    const uid = process.getuid!();
    const busctl = systemBin('busctl', existsSync);
    const tailBin = systemBin('tail', existsSync);
    expect(busctl).not.toBeNull();
    expect(tailBin).not.toBeNull();
    const avail = probeAvailability({ procRoot: '/proc', sysfsRoot: SYSFS, uid, selfPid: process.pid, busctl });
    expect(avail).toMatchObject({ ok: true });
    if (!avail.ok) return;
    const base = avail.userBase;
    const cpuDelegated = (readDeskFile(SYSFS, base, 'cgroup.subtree_control') ?? '').split(/\s+/).includes('cpu');

    const id = randomBytes(5).toString('hex');
    const root = `cwatch-e2e${id}.slice`;
    const sSlice = `cwatch-e2e${id}-s.slice`;
    const aSlice = `cwatch-e2e${id}-a.slice`;
    const term = `cwatch-e2e${id}-1.scope`;
    const sTail = `cwatch-e2e${id}-2.scope`;
    for (const u of [root, sSlice, aSlice, term, sTail]) expect(isTestUnitName(u), u).toBe(true);
    const real = (u: string) => `${base}/${u.endsWith('.scope') ? scopePath(u, u === term ? aSlice : sSlice) : slicePath(u)}`;
    // pont virtuel → test : nom d'unité et chemin de cgroup ; tout le reste est refusé
    const TERM_V = 'app-e2eterm.service';
    const names = new Map([['session.slice', sSlice], ['app.slice', aSlice], [TERM_V, term], ['cwatch.slice', root]]);
    const paths = new Map([
      [`${base}/session.slice`, real(sSlice)], [`${base}/app.slice`, real(aSlice)], [`${base}/app.slice/${TERM_V}`, real(term)], [`${base}/cwatch.slice`, real(root)],
    ]);
    const realClient = createDeskClient(createBusctl(busctl!, process.env));
    const sent: [string, unknown][] = [];
    const bridge: DeskClient = {
      setProps: async (unit, p) => {
        const t = names.get(unit);
        if (!t) throw new Error(`unité hors du test refusée : ${unit}`);
        sent.push([unit, p]);
        await realClient.setProps(t, p);
      },
      calls: () => realClient.calls(),
    };
    const chain = new Set(base.split('/').filter(Boolean).map((_, k, a) => `/${a.slice(0, k + 1).join('/')}`));
    const readCg = (cg: string, file: Parameters<typeof readDeskFile>[2]) => {
      // les niveaux système sont lus pour de vrai, sauf leur protection mémoire : simulée présente (sinon rien à poser)
      if (chain.has(cg) && (file === 'memory.low' || file === 'memory.min')) return file === 'memory.low' ? String(8 * 1024 * MiB) : '0';
      if (chain.has(cg)) return readDeskFile(SYSFS, cg, file);
      const t = paths.get(cg);
      if (!t) throw new Error(`cgroup hors du test refusé : ${cg}`);
      return readDeskFile(SYSFS, t, file);
    };
    const saved: DeskOriginals[] = [];
    const d = createDeskPriority({ client: bridge, readCg, saveOriginals: (o) => saved.push(structuredClone(o)), monoNow: () => 0, log: (m) => console.log(m) });

    const sys = createSystemdClient(createBusctl(busctl!, process.env));
    const kids: ChildProcess[] = [];
    const seen: string[] = [];
    const rd = (u: string, f: string) => readFileSync(join(SYSFS, real(u), f), 'utf8').trim();
    const cpuOf = (u: string) => (existsSync(join(SYSFS, real(u), 'cpu.weight')) ? rd(u, 'cpu.weight') : 'absent');
    let bodyErr: { e: unknown } | null = null;
    try {
      const t1 = spawn(tailBin!, ['-f', '/dev/null'], { stdio: 'ignore' });
      const t2 = spawn(tailBin!, ['-f', '/dev/null'], { stdio: 'ignore' });
      kids.push(t1, t2);
      await wait(() => !!t1.pid && !!t2.pid && readCgroup('/proc', t1.pid) !== null && readCgroup('/proc', t2.pid) !== null, 5000, 'enfants lancés');
      await sys.ensureSlice(root, { reserveBytes: 0, highBytes: 1024 * MiB, maxBytes: 2048 * MiB, swapMaxBytes: 0 });
      await sys.ensureProjectSlice(sSlice, null);
      await sys.ensureProjectSlice(aSlice, null);
      await sys.startScope(term, aSlice, [t1.pid!]);
      await sys.startScope(sTail, sSlice, [t2.pid!]);
      await wait(() => readCgroup('/proc', t1.pid!) === real(term) && readCgroup('/proc', t2.pid!) === real(sTail), 5000, 'tails dans leurs scopes');
      const before = { s: [cpuOf(sSlice), rd(sSlice, 'memory.low')], a: [cpuOf(aSlice), rd(aSlice, 'memory.low')], t: rd(term, 'memory.low'), r: cpuOf(root) };
      seen.push(`avant : ${JSON.stringify(before)}`);
      expect(before.t).toBe('0');

      const input = (on: boolean) => ({
        on, userBase: base, procs: [proc(t1.pid!, 'warp')], uid, cgroupOf: (pid: number) => (pid === t1.pid ? `${base}/app.slice/${TERM_V}` : null),
        reserveBytes: R, rootExists: true,
      });
      // 1) allumé : poids et protection posés (vus dans /sys), origines enregistrées avant
      d.tick(input(true));
      await d.idle();
      seen.push(`appels : ${JSON.stringify(sent)}`);
      expect(saved.length).toBeGreaterThan(0);
      await wait(() => [sSlice, aSlice, term].every((u) => rd(u, 'memory.low') === String(R)), 5000, 'protection posée');
      if (cpuDelegated) await wait(() => cpuOf(sSlice) === '200' && cpuOf(aSlice) === '150' && cpuOf(root) === '50', 5000, 'poids posés');
      seen.push(`allumé : s=${cpuOf(sSlice)}/${rd(sSlice, 'memory.low')} a=${cpuOf(aSlice)}/${rd(aSlice, 'memory.low')} terminal=${rd(term, 'memory.low')} racine=${cpuOf(root)}`);
      expect(d.state()).toMatchObject({ status: 'active', memory: 'on', cpu: cpuDelegated });

      // 2) régime établi : aucun appel D-Bus
      const n = bridge.calls();
      for (let k = 0; k < 5; k++) d.tick(input(true));
      await d.idle();
      expect(bridge.calls()).toBe(n);

      // 3) éteint : valeurs d'origine (protection 0, poids « non défini » → 100 ou contrôleur retiré), origines vidées
      d.tick(input(false));
      await d.idle();
      // systemd peut appliquer un peu après sa réponse D-Bus (réalisation des cgroups différée) : attente bornée
      await wait(() => [sSlice, aSlice, term].every((u) => rd(u, 'memory.low') === '0'), 5000, 'protection retirée');
      await wait(() => [sSlice, aSlice, root].every((u) => ['100', 'absent'].includes(cpuOf(u))), 5000, 'poids d’origine');
      expect(saved.at(-1)).toEqual({});
      seen.push(`éteint : s=${cpuOf(sSlice)}/${rd(sSlice, 'memory.low')} a=${cpuOf(aSlice)}/${rd(aSlice, 'memory.low')} terminal=${rd(term, 'memory.low')} racine=${cpuOf(root)}`);
      const m = bridge.calls();
      d.tick(input(false));
      await d.idle();
      expect(bridge.calls()).toBe(m);
    } catch (e) {
      bodyErr = { e };
    }
    const started = kids.filter((k) => k.pid !== undefined);
    for (const k of started) if (alive(k)) k.kill('SIGKILL');
    await Promise.race([
      Promise.all(started.map((k) => (alive(k) ? new Promise((r) => k.once('exit', r)) : null))),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    console.log(`[bureau prioritaire e2e]\n${seen.join('\n')}`);
    const errs: unknown[] = [];
    for (const u of [term, sTail, sSlice, aSlice, root]) {
      await sys.stopTestUnit(u).catch((e) => {
        if (!(e instanceof BusctlError && e.code === 'no-unit')) errs.push(e);
      });
    }
    if (bodyErr) throw bodyErr.e;
    if (errs.length) throw errs[0];
    await wait(() => !existsSync(join(SYSFS, real(root))), 10_000, 'slice de test retirée');
  },
  120_000,
);

test.skipIf(!RUN)('vrai système, lecture seule : ce que le bureau prioritaire ferait ici (aucun appel)', async () => {
  const uid = process.getuid!();
  const avail = probeAvailability({ procRoot: '/proc', sysfsRoot: SYSFS, uid, selfPid: process.pid, busctl: '/usr/bin/busctl' });
  if (!avail.ok) return;
  const calls: [string, unknown][] = [];
  const d = createDeskPriority({
    client: { setProps: async (u, p) => void calls.push([u, p]), calls: () => calls.length },
    readCg: (cg, f) => readDeskFile(SYSFS, cg, f),
    monoNow: () => 0,
    log: () => {},
  });
  // pas de processus : seulement session.slice et cwatch.slice seraient visées ; aucun vrai appel (faux client)
  d.tick({ on: true, userBase: avail.userBase, procs: [], uid, cgroupOf: () => null, reserveBytes: 4 * 1024 * MiB, rootExists: existsSync(join(SYSFS, avail.userBase, 'cwatch.slice')) });
  await d.idle();
  console.log(`[bureau prioritaire, vrai système en lecture] état : ${JSON.stringify(d.state())} ; appels qui seraient faits : ${JSON.stringify(calls)}`);
  for (const [u] of calls) expect(['session.slice', 'cwatch.slice']).toContain(u);
});
