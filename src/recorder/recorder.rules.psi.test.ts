// Règle anti-gel par défaut dans le service, sur la pression mémoire du bureau et des applis : faux /proc (mémoire utilisée
// 90 %, sous le seuil de 95 % comme pendant le gel du 2026-10-22, PSI de la machine réglable), faux /sys/fs/cgroup (PSI de
// session.slice, app.slice et cwatch.slice réglables), faux kill (espion), faux notificateur, horloge simulée.
// Aucun vrai signal : `kill` est un vi.fn().
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../core/config';
import { addProc, makeProcRoot } from '../core/collector/fakeProc';
import type { KillFn } from '../core/kill';
import type { Notifier, NotifyRequest } from './notify';
import { createRecorder } from './recorder';

const GB = 1024 * 1024;
const NM = '/home/u/demo/node_modules';
const psiText = (some: number, full: number) =>
  `some avg10=${some.toFixed(2)} avg60=0.00 avg300=0.00 total=0\nfull avg10=${full.toFixed(2)} avg60=0.00 avg300=0.00 total=0\n`;

/**
 * `machine(some, full)` : /proc/pressure/memory ; `slice(nom, full)` : memory.pressure d'une slice du gestionnaire
 * utilisateur (créée à la demande). `cgroups: false` : aucun faux /sys/fs/cgroup (repli sur la machine).
 * `slowTick()` : le prochain tick reste bloqué 15 s avant les règles (écriture ou lecture lente pendant un étouffement).
 */
function setup(o: { cgroups?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'pw-psi-'));
  const procRoot = makeProcRoot(100_000);
  writeFileSync(join(procRoot, 'meminfo'), 'MemTotal: 32000000 kB\nMemAvailable: 3200000 kB\nSwapTotal: 2000000 kB\nSwapFree: 0 kB\n');
  writeFileSync(join(procRoot, 'loadavg'), '1.00 1.00 1.00 1/100 999\n');
  mkdirSync(join(procRoot, 'pressure'));
  const psi = (text: string) => writeFileSync(join(procRoot, 'pressure', 'memory'), text);
  const machine = (some: number, full: number) => psi(psiText(some, full));
  machine(0, 0);
  const cgroupRoot = join(base, 'sys-fs-cgroup');
  const manager = join(cgroupRoot, 'user.slice', 'user-1000.slice', 'user@1000.service');
  const slice = (name: string, full: number) => {
    mkdirSync(join(manager, name), { recursive: true });
    writeFileSync(join(manager, name, 'memory.pressure'), psiText(full, full));
  };
  if (o.cgroups !== false) for (const n of ['session.slice', 'app.slice', 'cwatch.slice']) slice(n, 0);
  addProc(procRoot, { pid: 1, comm: 'systemd', ppid: 0, uid: 0, rssKB: 10_000, cmdline: ['/sbin/init'] });
  addProc(procRoot, { pid: 500, comm: 'systemd', ppid: 1, rssKB: 10_000, cmdline: ['systemd', '--user'] });
  addProc(procRoot, { pid: 900, comm: 'node', ppid: 500, rssKB: 50_000, cmdline: ['node', '/x/out/main/recorder.js'] });
  addProc(procRoot, { pid: 600, comm: 'warp', ppid: 500, rssKB: 300_000, cmdline: ['warp'] });
  addProc(procRoot, { pid: 601, comm: 'zsh', ppid: 600, rssKB: 5_000, cmdline: ['zsh'], cwd: '/home/u/demo' });
  // jest (Node ≥ 24 : comm « MainThread ») et ses deux workers : 5,3 Go
  addProc(procRoot, { pid: 700, comm: 'MainThread', ppid: 601, starttime: 7000, rssKB: 0.3 * GB, cwd: '/home/u/demo', cmdline: ['node', `${NM}/jest/bin/jest.js`] });
  for (const pid of [701, 702]) {
    addProc(procRoot, { pid, comm: 'MainThread', ppid: 700, starttime: pid * 10, rssKB: 2.5 * GB, cwd: '/home/u/demo', cmdline: ['node', `${NM}/jest-worker/build/workers/processChild.js`] });
  }
  // session Claude et un très gros serveur MCP (12 Go, le plus gros processus) : jamais visés
  addProc(procRoot, { pid: 800, comm: 'claude', ppid: 601, rssKB: 1.2 * GB, cmdline: ['claude'] });
  addProc(procRoot, { pid: 820, comm: 'node', ppid: 800, rssKB: 12 * GB, cmdline: ['node', '/home/u/.npm/_npx/1a2b3c/node_modules/@playwright/mcp/cli.js'] });
  const cfgDir = join(base, 'cfg');
  mkdirSync(cfgDir, { recursive: true });
  // config d'un nouvel utilisateur : règles recommandées, anti-gel Actif sur la pression
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ ...DEFAULT_CONFIG, recorder: { ...DEFAULT_CONFIG.recorder, intervalSec: 5 }, classify: { detectPorts: false, overrides: {} } }));
  let t = 10_000_000;
  let mono = 0;
  let slow = false;
  const kill = vi.fn<KillFn>();
  const notify = vi.fn(async (_r: NotifyRequest) => null);
  const notifier: Notifier = { notify, state: () => 'actions' };
  const rec = createRecorder({
    dataDir: join(base, 'data'), configDir: cfgDir, procRoot, now: () => t, cpuCount: 4, log: () => {}, notifier,
    focusFile: join(base, 'data', 'app-focus.json'), kill, selfPid: 900, currentUid: 1000, appRoot: null, monoNow: () => mono,
    ruleTimers: { setTimeout: () => 0 },
    cgroupRoot: o.cgroups === false ? null : cgroupRoot,
    // une partition surveillée : statfs est lu à chaque tick, avant les règles
    mountinfo: () => '30 1 8:2 / / rw - ext4 /dev/sda2 rw',
    statfs: () => {
      if (slow) {
        slow = false;
        t += 15_000;
        mono += 15_000;
      }
      return { sizeKB: 100_000_000, availKB: 50_000_000 };
    },
  });
  const events = (like = 'rule_%') => {
    const db = new DatabaseSync(join(base, 'data', 'metrics.db'), { readOnly: true });
    const rows = (db.prepare('SELECT type, detail FROM events WHERE type LIKE ? ORDER BY id').all(like) as { type: string; detail: string }[])
      .map((e) => ({ type: e.type, ...JSON.parse(e.detail) }));
    db.close();
    return rows;
  };
  const run = (ms: number) => {
    for (let s = 0; s < ms; s += 5_000) {
      t += 5_000;
      mono += 5_000;
      rec.tick();
    }
  };
  return { rec, kill, notify, events, run, psi, machine, slice, slowTick: () => { slow = true; } };
}

const signalled = (k: ReturnType<typeof vi.fn<KillFn>>) => k.mock.calls.map(([pid, sig]) => `${pid}:${sig}`).sort();
const flush = () => new Promise((r) => setTimeout(r, 0));
const JEST = ['700:SIGTERM', '701:SIGTERM', '702:SIGTERM'];

test('projet freiné par son budget (cwatch.slice 90 %, machine some 70 / full 55) mais bureau et applis à 0 : jamais', () => {
  const s = setup();
  s.machine(70, 55);
  s.slice('cwatch.slice', 90);
  s.rec.start();
  s.run(5 * 60_000);
  expect(s.kill).not.toHaveBeenCalled();
  expect(s.events()).toEqual([]);
  s.rec.stop();
});

test('applis étouffées (app.slice 55 % tenue 20 s), mémoire 90 % : jest arrêté, événement et notification ; jamais Claude ni le serveur MCP', async () => {
  const s = setup();
  s.rec.start();
  s.rec.tick();
  s.run(30_000);
  expect(s.kill).not.toHaveBeenCalled();
  s.slice('app.slice', 55);
  s.run(20_000);
  expect(s.kill).not.toHaveBeenCalled();
  s.run(5_000);
  expect(signalled(s.kill)).toEqual(JEST);
  const trigger = 'pression mémoire du bureau et des applis 55 % depuis 20 s';
  expect(s.events()).toEqual([
    expect.objectContaining({ type: 'rule_action', ruleId: 'rec-antigel', rule: 'Machine saturée : tuer les tests', result: 'sigterm', killed: 3, trigger }),
  ]);
  await flush();
  const sent = s.notify.mock.calls.map(([r]) => r).filter((r) => r.title.endsWith('Règle exécutée'));
  expect(sent).toHaveLength(1);
  expect(sent[0]!.body).toContain(`Déclencheur : ${trigger}.`);
  // la pression continue : rien tant que jest n'est pas mort ; jamais claude (800) ni son serveur MCP (820)
  s.run(30_000);
  for (const [pid] of s.kill.mock.calls) expect([700, 701, 702]).toContain(pid);
  s.rec.stop();
});

test('bureau étouffé (session.slice 60 % tenue 20 s), applis à 0 : jest arrêté', () => {
  const s = setup();
  s.rec.start();
  s.slice('session.slice', 60);
  s.run(20_000); // première mesure à 5 s : 15 s de tenue
  expect(s.kill).not.toHaveBeenCalled();
  s.run(5_000);
  expect(signalled(s.kill)).toEqual(JEST);
  expect(s.events()[0]).toMatchObject({ trigger: 'pression mémoire du bureau et des applis 60 % depuis 20 s' });
  s.rec.stop();
});

test('repli : aucun cgroup interactif lisible (session sans systemd) → PSI full de la machine, dite comme telle', () => {
  const s = setup({ cgroups: false });
  s.rec.start();
  s.machine(70, 55);
  s.run(20_000);
  expect(s.kill).not.toHaveBeenCalled();
  s.run(5_000);
  expect(signalled(s.kill)).toEqual(JEST);
  expect(s.events()[0]).toMatchObject({ trigger: 'pression mémoire de la machine 55 % depuis 20 s' });
  s.rec.stop();
});

test('repli sur un noyau sans ligne « full » (PSI some seule, même à 90 %) : jamais', () => {
  const s = setup({ cgroups: false });
  s.psi('some avg10=90.00 avg60=0.00 avg300=0.00 total=0\n');
  s.rec.start();
  s.run(3 * 60_000);
  expect(s.kill).not.toHaveBeenCalled();
  expect(s.events()).toEqual([]);
  s.rec.stop();
});

test('tick bloqué 15 s pendant l’étouffement : la tenue de la pression continue (pas prise pour une veille)', () => {
  const s = setup();
  s.rec.start();
  s.rec.tick();
  s.slice('app.slice', 55);
  s.run(10_000); // tenue depuis 5 s
  s.slowTick();
  s.run(5_000); // tick à 15 s, bloqué jusqu'à 30 s : évalué à l'instant de ses mesures (10 s de tenue)
  expect(s.kill).not.toHaveBeenCalled();
  s.rec.tick(); // le suivant part aussitôt (intervalle échu pendant le blocage) : 25 s de pression, sans trou
  expect(signalled(s.kill)).toEqual(JEST);
  expect(s.events()[0]).toMatchObject({ ruleId: 'rec-antigel', trigger: 'pression mémoire du bureau et des applis 55 % depuis 25 s' });
  s.rec.stop();
});

test('alerte « Pression mémoire » sur le même signal : projet freiné → aucune ; applis à 30 % → une, avec sa portée', () => {
  const s = setup();
  s.machine(70, 55);
  s.slice('cwatch.slice', 90);
  s.rec.start();
  s.run(60_000);
  expect(s.events('pressure')).toEqual([]);
  s.slice('app.slice', 30);
  s.run(5_000);
  expect(s.events('pressure')).toEqual([{ type: 'pressure', psi: 30, scope: 'interactive' }]);
  // sous le seuil de la règle (40 %) : alerte seulement
  expect(s.kill).not.toHaveBeenCalled();
  s.rec.stop();
});
