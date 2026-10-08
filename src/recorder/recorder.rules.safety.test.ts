// Revue de sécurité de la piste I, service complet : faux /proc, kill espion (jamais un vrai signal), horloges simulées.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../core/config';
import { addProc, makeProcRoot } from '../core/collector/fakeProc';
import type { KillFn } from '../core/kill';
import { RULE_TEMPLATES } from '../core/rules/config';
import type { Rule, RulesConfig } from '../core/rules/types';
import type { Notifier, NotifyRequest } from './notify';
import { createRecorder, inactiveCpuThreshold } from './recorder';

const GB = 1024 * 1024;
const MIN = 60_000;
const H = 3600_000;
const T0 = 10_000_000_000;

/** Règle active, en Simulation depuis plus de 10 min (sinon le service la traite comme une simulation). */
const active = (over: Partial<Rule> = {}): Rule => ({
  ...RULE_TEMPLATES[0]!, id: 'r-v', createdAt: 0, enabled: true, mode: 'active', simulatedSince: T0 - H, ...over,
  condition: { ...(RULE_TEMPLATES[0]!.condition as object), forMin: 1 } as Rule['condition'],
});

function setup(rules: RulesConfig) {
  const base = mkdtempSync(join(tmpdir(), 'pw-rules-safe-'));
  const procRoot = makeProcRoot(100_000);
  writeFileSync(join(procRoot, 'meminfo'), 'MemTotal: 32000000 kB\nMemAvailable: 16000000 kB\nSwapTotal: 2000000 kB\nSwapFree: 1000000 kB\n');
  writeFileSync(join(procRoot, 'loadavg'), '1.00 1.00 1.00 1/100 999\n');
  addProc(procRoot, { pid: 1, comm: 'systemd', ppid: 0, uid: 0, rssKB: 10_000, cmdline: ['/sbin/init'] });
  addProc(procRoot, { pid: 500, comm: 'systemd', ppid: 1, rssKB: 10_000, cmdline: ['systemd', '--user'] });
  addProc(procRoot, { pid: 900, comm: 'node', ppid: 500, rssKB: 50_000, cmdline: ['node', '/x/out/main/recorder.js'] });
  addProc(procRoot, { pid: 700, comm: 'node', ppid: 500, starttime: 7000, rssKB: 5 * GB, cwd: '/home/u/acme', cmdline: ['node', '/home/u/acme/node_modules/.bin/vitest', 'run'] });
  const cfgDir = join(base, 'cfg');
  mkdirSync(cfgDir, { recursive: true });
  const writeCfg = (r: RulesConfig) =>
    writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({
      ...DEFAULT_CONFIG, recorder: { ...DEFAULT_CONFIG.recorder, intervalSec: 30 }, classify: { detectPorts: false, overrides: {} }, rules: r,
    }));
  writeCfg(rules);
  let wall = T0;
  let mono = 1_000;
  const kill = vi.fn<KillFn>();
  const notify = vi.fn(async (_r: NotifyRequest) => null);
  const notifier: Notifier = { notify, state: () => 'actions' };
  const timers: (() => void)[] = [];
  const logs: string[] = [];
  const rec = createRecorder({
    dataDir: join(base, 'data'), configDir: cfgDir, procRoot, now: () => wall, monoNow: () => mono, cpuCount: 4, log: (m) => logs.push(m), notifier,
    focusFile: join(base, 'data', 'f.json'), kill, selfPid: 900, currentUid: 1000, appRoot: null, ruleTimers: { setTimeout: (fn) => timers.push(fn) },
  });
  const run = (ms: number) => {
    for (let s = 0; s < ms; s += 30_000) {
      wall += 30_000;
      mono += 30_000;
      rec.tick();
    }
  };
  const db = () => new DatabaseSync(join(base, 'data', 'metrics.db'), { readOnly: true });
  const events = () => (db().prepare("SELECT type, detail FROM events WHERE type LIKE 'rule_%' ORDER BY id").all() as { type: string; detail: string }[])
    .map((e) => ({ type: e.type, ...JSON.parse(e.detail) }));
  return { rec, kill, timers, logs, run, writeCfg, cfgDir, events, notify, setWall: (v: number) => (wall = v), wall: () => wall };
}

describe('I-5 : interrupteur éteint pendant les 5 s → aucun SIGKILL', () => {
  test('R4', () => {
    const s = setup({ enabled: true, list: [active()] });
    s.rec.start();
    s.run(3 * MIN);
    expect(s.kill.mock.calls).toEqual([[700, 'SIGTERM']]);
    s.writeCfg({ enabled: false, list: [active()] });
    s.rec.reloadConfig();
    s.timers.forEach((f) => f());
    expect(s.kill.mock.calls).toEqual([[700, 'SIGTERM']]);
    s.rec.stop();
  });
  test('règle repassée en Simulation pendant les 5 s → aucun SIGKILL ; inchangée → SIGKILL', () => {
    const s = setup({ enabled: true, list: [active()] });
    s.rec.start();
    s.run(3 * MIN);
    s.writeCfg({ enabled: true, list: [active({ mode: 'simulate' })] });
    s.rec.reloadConfig();
    s.timers.forEach((f) => f());
    expect(s.kill.mock.calls).toEqual([[700, 'SIGTERM']]);
    const s2 = setup({ enabled: true, list: [active()] });
    s2.rec.start();
    s2.run(3 * MIN);
    s2.rec.reloadConfig();
    s2.timers.forEach((f) => f());
    expect(s2.kill.mock.calls).toEqual([[700, 'SIGTERM'], [700, 'SIGKILL']]);
    s.rec.stop();
    s2.rec.stop();
  });
});

describe('I-1 : horloge murale qui recule dans le service', () => {
  test('E1d : un seul SIGTERM sur 2 min réelles malgré un recul de 2 h', () => {
    const s = setup({ enabled: true, list: [active()] });
    s.rec.start();
    s.run(2 * MIN);
    expect(s.kill.mock.calls.filter((c) => c[1] === 'SIGTERM')).toHaveLength(1);
    s.setWall(s.wall() - 2 * H);
    s.run(2 * MIN);
    expect(s.kill.mock.calls.filter((c) => c[1] === 'SIGTERM')).toHaveLength(1);
    s.rec.stop();
  });
});

describe('M-3 : une règle Active sans période de Simulation est traitée comme une simulation', () => {
  test('nouvelle règle écrite à la main directement en active (sans simulatedSince) → simulation, journalisé', () => {
    const s = setup({ enabled: true, list: [active({ simulatedSince: undefined })] });
    s.rec.start();
    s.run(3 * MIN);
    expect(s.kill).not.toHaveBeenCalled();
    expect(s.events().map((e) => e.type)).toEqual(['rule_dry_run']);
    expect(s.logs.filter((l) => /traitée en Simulation/.test(l))).toHaveLength(1);
    s.rec.stop();
  });
  test('Simulation commencée il y a moins de 10 min → simulation ; plus de 10 min → active', () => {
    const s = setup({ enabled: true, list: [active({ simulatedSince: T0 - 5 * MIN })] });
    s.rec.start();
    s.run(3 * MIN);
    expect(s.kill).not.toHaveBeenCalled();
    s.run(5 * MIN); // T0 + 8 min : 13 min de Simulation, cooldown passé
    expect(s.kill.mock.calls.filter((c) => c[1] === 'SIGTERM')).toHaveLength(1);
    s.rec.stop();
  });
  test('simulatedSince dans le futur → simulation', () => {
    const s = setup({ enabled: true, list: [active({ simulatedSince: T0 + H })] });
    s.rec.start();
    s.run(3 * MIN);
    expect(s.kill).not.toHaveBeenCalled();
    s.rec.stop();
  });
});

describe('M-4 : une ligne de journal par ensemble de règles invalides', () => {
  test('3 règles invalides → 1 ligne', () => {
    const bad = (id: string) => ({ ...active({ id }), condition: { ...active().condition, overMB: 1 } }) as Rule;
    const s = setup({ enabled: true, list: [bad('a'), bad('b'), bad('c'), active()] });
    expect(s.logs.filter((l) => /ignorée/.test(l))).toHaveLength(1);
    expect(s.logs.find((l) => /ignorée/.test(l))).toMatch(/3 règles ignorées/);
    s.rec.reloadConfig();
    expect(s.logs.filter((l) => /ignorée/.test(l))).toHaveLength(1);
  });
});

describe('M-5 : seuil d’activité = max(1, procMinCpuPercent)', () => {
  test('inactiveCpuThreshold', () => {
    expect(inactiveCpuThreshold({ ...DEFAULT_CONFIG.recorder, procMinCpuPercent: 0 })).toBe(1);
    expect(inactiveCpuThreshold({ ...DEFAULT_CONFIG.recorder, procMinCpuPercent: 1 })).toBe(1);
    expect(inactiveCpuThreshold({ ...DEFAULT_CONFIG.recorder, procMinCpuPercent: 5 })).toBe(5);
  });
});

describe('C3 : config tronquée pendant l’exécution → règles éteintes', () => {
  test('aucun kill', () => {
    const s = setup({ enabled: true, list: [active()] });
    s.rec.start();
    writeFileSync(join(s.cfgDir, 'config.json'), '{"version":1,"rules":');
    s.rec.reloadConfig();
    s.run(8 * MIN);
    expect(s.kill).not.toHaveBeenCalled();
    s.rec.stop();
  });
});
