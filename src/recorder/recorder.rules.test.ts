// Règles automatiques dans le service : faux /proc, faux kill (espion), faux notificateur, horloge simulée.
// Aucun vrai signal : `kill` est un vi.fn().
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../core/config';
import { addProc, makeProcRoot } from '../core/collector/fakeProc';
import type { KillFn } from '../core/kill';
import { RULE_TEMPLATES } from '../core/rules/config';
import type { Rule, RulesConfig } from '../core/rules/types';
import type { Notifier, NotifyRequest } from './notify';
import { createRecorder } from './recorder';

const GB = 1024 * 1024;
const vitestRule = (over: Partial<Rule> = {}): Rule => ({ ...RULE_TEMPLATES[0]!, id: 'r-v', createdAt: 0, enabled: true, ...over });

function setup(o: { rules?: RulesConfig; protectedNames?: string[] } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'pw-rules-'));
  const procRoot = makeProcRoot(100_000);
  writeFileSync(join(procRoot, 'meminfo'), 'MemTotal: 32000000 kB\nMemAvailable: 16000000 kB\nSwapTotal: 2000000 kB\nSwapFree: 1000000 kB\n');
  writeFileSync(join(procRoot, 'loadavg'), '1.00 1.00 1.00 1/100 999\n');
  // chaîne du service : 1 → 500 (systemd --user) → 900 (service, selfPid)
  addProc(procRoot, { pid: 1, comm: 'systemd', ppid: 0, uid: 0, rssKB: 10_000, cmdline: ['/sbin/init'] });
  addProc(procRoot, { pid: 500, comm: 'systemd', ppid: 1, rssKB: 10_000, cmdline: ['systemd', '--user'] });
  addProc(procRoot, { pid: 900, comm: 'node', ppid: 500, rssKB: 50_000, cmdline: ['node', '/x/out/main/recorder.js'] });
  // instance vitest de projet à 5 Go
  addProc(procRoot, {
    pid: 700, comm: 'node', ppid: 500, starttime: 7000, rssKB: 5 * GB, cwd: '/home/u/acme',
    cmdline: ['node', '/home/u/acme/node_modules/.bin/vitest', 'run'],
  });
  const cfgDir = join(base, 'cfg');
  mkdirSync(cfgDir, { recursive: true });
  const writeCfg = (rules: RulesConfig) =>
    writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({
      ...DEFAULT_CONFIG, recorder: { ...DEFAULT_CONFIG.recorder, intervalSec: 30 }, protected: o.protectedNames ?? DEFAULT_CONFIG.protected,
      classify: { detectPorts: false, overrides: {} }, rules,
    }));
  writeCfg(o.rules ?? { enabled: true, list: [vitestRule()] });
  // crédit de Simulation déjà enregistré (sinon une règle Active est traitée en Simulation, voir recorder.rules.safety)
  mkdirSync(join(base, 'data'), { recursive: true });
  writeFileSync(join(base, 'data', 'rules-simulation.json'), JSON.stringify({ 'r-v': { condition: JSON.stringify(vitestRule().condition), simulatedMs: 3600_000, evaluations: 100 } }));
  let t = 10_000_000;
  let mono = 0;
  const kill = vi.fn<KillFn>();
  const notify = vi.fn(async (_r: NotifyRequest) => null);
  const notifier: Notifier = { notify, state: () => 'actions' };
  const timers: (() => void)[] = [];
  const logs: string[] = [];
  const rec = createRecorder({
    dataDir: join(base, 'data'), configDir: cfgDir, procRoot, now: () => t, cpuCount: 4, log: (m) => logs.push(m), notifier,
    focusFile: join(base, 'data', 'app-focus.json'), kill, selfPid: 900, currentUid: 1000, appRoot: null, monoNow: () => mono,
    ruleTimers: { setTimeout: (fn) => timers.push(fn) },
  });
  const db = () => new DatabaseSync(join(base, 'data', 'metrics.db'), { readOnly: true });
  const events = () => (db().prepare("SELECT type, detail FROM events WHERE type LIKE 'rule_%' ORDER BY id").all() as { type: string; detail: string }[])
    .map((e) => ({ type: e.type, ...JSON.parse(e.detail) }));
  /** Ticks toutes les 30 s pendant `ms`. */
  const run = (ms: number) => {
    for (let s = 0; s < ms; s += 30_000) {
      t += 30_000;
      mono += 30_000;
      rec.tick();
    }
  };
  return { rec, kill, notify, timers, logs, events, run, writeCfg };
}

test('Simulation : 6 min de ticks → 1 rule_dry_run, kill jamais appelé ; 5 min plus tard → 2ᵉ événement', () => {
  const s = setup();
  s.rec.start();
  s.rec.tick();
  s.run(6 * 60_000);
  expect(s.events()).toEqual([expect.objectContaining({ type: 'rule_dry_run', ruleId: 'r-v', result: 'dry_run', pids: [700], target: 'vitest (u / acme)' })]);
  s.run(5 * 60_000 + 30_000);
  expect(s.events()).toHaveLength(2);
  expect(s.kill).not.toHaveBeenCalled();
  expect(s.timers).toEqual([]);
  expect(s.rec.stats().classifyRuns).toBeGreaterThan(0);
  s.rec.stop();
});

test('règle passée en Active (config réécrite + reloadConfig) → kill(700, SIGTERM) une fois, rule_action, notification ; escalade SIGKILL après 5 s', async () => {
  const s = setup({ rules: { enabled: true, list: [vitestRule({ enabled: false })] } });
  s.rec.start();
  s.rec.tick();
  s.writeCfg({ enabled: true, list: [vitestRule({ mode: 'active' })] });
  s.rec.reloadConfig();
  s.run(6 * 60_000);
  expect(s.kill.mock.calls).toEqual([[700, 'SIGTERM']]);
  expect(s.events()).toEqual([expect.objectContaining({ type: 'rule_action', ruleId: 'r-v', result: 'sigterm', killed: 1 })]);
  await new Promise((r) => setTimeout(r, 0));
  expect(s.notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Computer Watcher — Règle exécutée' }));
  expect(s.timers).toHaveLength(1);
  s.timers[0]!();
  expect(s.kill.mock.calls).toEqual([[700, 'SIGTERM'], [700, 'SIGKILL']]);
  s.rec.stop();
});

test('instance protégée par la config (protected contient node) → aucun fire, aucun kill, « rien à arrêter » journalisé', () => {
  const s = setup({ protectedNames: ['node'], rules: { enabled: true, list: [vitestRule({ mode: 'active' })] } });
  s.rec.start();
  s.run(7 * 60_000);
  expect(s.events()).toEqual([]);
  expect(s.kill).not.toHaveBeenCalled();
  expect(s.logs.some((l) => /rien à arrêter/.test(l))).toBe(true);
  s.rec.stop();
});

test('règle désactivée → aucun classement, aucun événement', () => {
  const s = setup({ rules: { enabled: true, list: [vitestRule({ enabled: false, mode: 'active' })] } });
  s.rec.start();
  s.run(7 * 60_000);
  expect(s.rec.stats()).toEqual({ classifyRuns: 0, ruleEvaluations: 0 });
  expect(s.events()).toEqual([]);
  expect(s.kill).not.toHaveBeenCalled();
  s.rec.stop();
});

test('interrupteur général éteint → rien ne tourne, pas même les simulations', () => {
  const s = setup({ rules: { enabled: false, list: [vitestRule(), vitestRule({ id: 'r-w', mode: 'active' })] } });
  s.rec.start();
  s.run(12 * 60_000);
  expect(s.rec.stats()).toEqual({ classifyRuns: 0, ruleEvaluations: 0 });
  expect(s.events()).toEqual([]);
  expect(s.kill).not.toHaveBeenCalled();
  s.rec.stop();
});

test('quota restauré après un redémarrage : pas de second déclenchement dans les 5 min', () => {
  const s = setup();
  s.rec.start();
  s.run(6 * 60_000);
  expect(s.events()).toHaveLength(1);
  s.rec.stop();
  s.rec.start(); // même base : lastFire relu
  s.run(4 * 60_000);
  expect(s.events()).toHaveLength(1);
  s.rec.stop();
});

test('règle invalide écrite à la main → ignorée seule, journalisée ; la valide tourne', () => {
  const s = setup();
  const bad = { ...vitestRule({ id: 'r-bad', name: 'cassée' }), condition: { ...vitestRule().condition, overMB: 1 } };
  s.writeCfg({ enabled: true, list: [bad as Rule, vitestRule()] });
  s.rec.reloadConfig();
  expect(s.logs.some((l) => /1 règle ignorée : « cassée » \(seuil/.test(l))).toBe(true);
  s.rec.start();
  s.run(6 * 60_000);
  expect(s.events().map((e) => e.ruleId)).toEqual(['r-v']);
  s.rec.stop();
});
