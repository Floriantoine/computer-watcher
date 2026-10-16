// Règle anti-gel par défaut dans le service : faux /proc (meminfo réglable), faux kill (espion), horloge simulée.
// Aucun vrai signal : `kill` est un vi.fn().
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function setup(o: { availPercent?: number; rules?: unknown } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'pw-antigel-'));
  const procRoot = makeProcRoot(100_000);
  const meminfo = (availPercent: number) =>
    writeFileSync(join(procRoot, 'meminfo'), `MemTotal: 32000000 kB\nMemAvailable: ${Math.round(320_000 * availPercent)} kB\nSwapTotal: 2000000 kB\nSwapFree: 0 kB\n`);
  meminfo(o.availPercent ?? 2);
  writeFileSync(join(procRoot, 'loadavg'), '1.00 1.00 1.00 1/100 999\n');
  addProc(procRoot, { pid: 1, comm: 'systemd', ppid: 0, uid: 0, rssKB: 10_000, cmdline: ['/sbin/init'] });
  addProc(procRoot, { pid: 500, comm: 'systemd', ppid: 1, rssKB: 10_000, cmdline: ['systemd', '--user'] });
  addProc(procRoot, { pid: 900, comm: 'node', ppid: 500, rssKB: 50_000, cmdline: ['node', '/x/out/main/recorder.js'] });
  addProc(procRoot, { pid: 600, comm: 'warp', ppid: 500, rssKB: 300_000, cmdline: ['warp'] });
  addProc(procRoot, { pid: 601, comm: 'zsh', ppid: 600, rssKB: 5_000, cmdline: ['zsh'], cwd: '/home/u/demo' });
  // jest (comm node) et ses deux workers au comm « MainThread »
  addProc(procRoot, { pid: 700, comm: 'node', ppid: 601, starttime: 7000, rssKB: 0.3 * GB, cwd: '/home/u/demo', cmdline: ['node', `${NM}/jest/bin/jest.js`] });
  for (const pid of [701, 702]) {
    addProc(procRoot, { pid, comm: 'MainThread', ppid: 700, starttime: pid * 10, rssKB: 2.5 * GB, cwd: '/home/u/demo', cmdline: ['node', `${NM}/jest-worker/build/workers/processChild.js`] });
  }
  // tsc --noEmit (comm MainThread)
  addProc(procRoot, { pid: 710, comm: 'MainThread', ppid: 601, starttime: 7100, rssKB: 4 * GB, cwd: '/home/u/demo', cmdline: ['node', `${NM}/typescript/bin/tsc`, '--noEmit'] });
  // tsc lancé par Claude : jamais visé, même s'il est le plus gros
  addProc(procRoot, { pid: 800, comm: 'claude', ppid: 601, rssKB: 400_000, cmdline: ['claude'] });
  addProc(procRoot, { pid: 801, comm: 'zsh', ppid: 800, rssKB: 5_000, cmdline: ['/bin/zsh', '-c', 'tsc'] });
  addProc(procRoot, { pid: 810, comm: 'MainThread', ppid: 801, starttime: 8100, rssKB: 9 * GB, cwd: '/home/u/demo', cmdline: ['node', `${NM}/typescript/bin/tsc`, '--noEmit'] });
  const cfgDir = join(base, 'cfg');
  mkdirSync(cfgDir, { recursive: true });
  // config d'un nouvel utilisateur : pas de section « rules » → règles recommandées (anti-gel Active)
  const { rules: _r, ...cfg } = { ...DEFAULT_CONFIG, recorder: { ...DEFAULT_CONFIG.recorder, intervalSec: 5 }, classify: { detectPorts: false, overrides: {} } };
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify(o.rules === undefined ? cfg : { ...cfg, rules: o.rules }));
  let t = 10_000_000;
  let mono = 0;
  const kill = vi.fn<KillFn>();
  const notifier: Notifier = { notify: vi.fn(async (_r: NotifyRequest) => null), state: () => 'actions' };
  const timers: (() => void)[] = [];
  const logs: string[] = [];
  const rec = createRecorder({
    dataDir: join(base, 'data'), configDir: cfgDir, procRoot, now: () => t, cpuCount: 4, log: (m) => logs.push(m), notifier,
    focusFile: join(base, 'data', 'app-focus.json'), kill, selfPid: 900, currentUid: 1000, appRoot: null, monoNow: () => mono,
    ruleTimers: { setTimeout: (fn) => timers.push(fn) },
  });
  const events = () => {
    const db = new DatabaseSync(join(base, 'data', 'metrics.db'), { readOnly: true });
    const rows = (db.prepare("SELECT type, detail FROM events WHERE type LIKE 'rule_%' ORDER BY id").all() as { type: string; detail: string }[])
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
  const killProc = (...pids: number[]) => pids.forEach((pid) => rmSync(join(procRoot, String(pid)), { recursive: true, force: true }));
  return { rec, kill, timers, logs, events, run, killProc, meminfo, procRoot };
}

const signalled = (k: ReturnType<typeof vi.fn<KillFn>>) => k.mock.calls.map(([pid, sig]) => `${pid}:${sig}`).sort();

test('nouvel utilisateur, RAM à 98 % : jest et ses workers, puis tsc ; jamais le tsc de Claude, ni zsh, warp, claude', () => {
  const s = setup();
  s.rec.start();
  s.rec.tick();
  s.run(10_000);
  expect(s.kill).not.toHaveBeenCalled();
  s.run(5_000);
  expect(signalled(s.kill)).toEqual(['700:SIGTERM', '701:SIGTERM', '702:SIGTERM']);
  const ev = s.events();
  expect(ev).toEqual([expect.objectContaining({ type: 'rule_action', ruleId: 'rec-antigel', result: 'sigterm', killed: 3, trigger: expect.stringMatching(/^mémoire 98 % depuis 1[05] s$/) })]);
  // escalade : les processus sont morts entre-temps, rien à forcer
  s.killProc(700, 701, 702);
  s.timers.splice(0).forEach((f) => f());
  s.kill.mockClear();
  // une victime à la fois : la suivante après le délai de stabilisation, si la mémoire est toujours pleine
  s.run(15_000);
  expect(signalled(s.kill)).toEqual(['710:SIGTERM']);
  s.killProc(710);
  s.kill.mockClear();
  s.run(120_000);
  expect(s.kill).not.toHaveBeenCalled();
  expect(s.logs.some((l) => /rien à arrêter/.test(l))).toBe(true);
  s.rec.stop();
});

test('victime vivante : la suivante n’est pas visée avant 60 s', () => {
  const s = setup();
  s.rec.start();
  s.rec.tick();
  s.run(15_000);
  expect(signalled(s.kill)).toEqual(['700:SIGTERM', '701:SIGTERM', '702:SIGTERM']);
  s.kill.mockClear();
  s.run(55_000);
  expect(s.kill).not.toHaveBeenCalled();
  s.rec.stop();
});

test('RAM à 70 % : rien, jamais', () => {
  const s = setup({ availPercent: 30 });
  s.rec.start();
  s.run(10 * 60_000);
  expect(s.kill).not.toHaveBeenCalled();
  expect(s.events()).toEqual([]);
  s.rec.stop();
});

test('/proc/meminfo illisible : aucune évaluation, aucun signal', () => {
  const s = setup();
  rmSync(join(s.procRoot, 'meminfo'));
  s.rec.start();
  s.run(5 * 60_000);
  expect(s.kill).not.toHaveBeenCalled();
  s.rec.stop();
});

test('utilisateur existant (section rules présente, vide) : rien n’est ajouté, rien n’agit', () => {
  const s = setup({ rules: { enabled: false, list: [] } });
  s.rec.start();
  s.run(5 * 60_000);
  expect(s.kill).not.toHaveBeenCalled();
  expect(s.events()).toEqual([]);
  s.rec.stop();
});

test('anti-gel passé en Simulation : un rule_dry_run, aucun signal', () => {
  const rule = { ...DEFAULT_CONFIG.rules.list.find((r) => r.id === 'rec-antigel')!, mode: 'simulate' };
  const s = setup({ rules: { enabled: true, list: [rule] } });
  s.rec.start();
  s.rec.tick();
  s.run(4 * 60_000);
  expect(s.kill).not.toHaveBeenCalled();
  expect(s.timers).toEqual([]);
  expect(s.events()).toEqual([expect.objectContaining({ type: 'rule_dry_run', ruleId: 'rec-antigel', result: 'dry_run', pids: [700, 701, 702] })]);
  s.rec.stop();
});
