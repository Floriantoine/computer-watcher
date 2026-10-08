// Revue de sécurité de la piste I : revérifications juste avant le signal. kill = vi.fn(), jamais un vrai signal.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { AlertEvent } from '../core/alerts';
import { openHistoryDb } from '../core/history/db';
import type { KillFn } from '../core/kill';
import type { RuleDecision } from '../core/rules/engine';
import { filterTargets } from '../core/rules/neverKill';
import type { ProcSample } from '../core/types';
import { createRuleRunner, type RuleRunnerDeps } from './ruleRunner';

const GB = 1024 * 1024;
const P = (pid: number, ppid: number, name: string, o: Partial<ProcSample> = {}): ProcSample => ({
  pid, ppid, name, cmdline: name, uid: 1000, startTicks: pid * 10, ageSec: 1, cpuTicks: 0, rssKB: GB, swapKB: 0, cwd: null, cwdDeleted: false, ...o,
});
const base = [P(1, 0, 'systemd', { uid: 0 }), P(500, 1, 'systemd'), P(900, 500, 'node', { cmdline: 'node /x/recorder.js' })];
const fire = (pid = 777, revision = 'rev-1'): Extract<RuleDecision, { outcome: 'fire' }> => ({
  ruleId: 'r', ruleName: 'r', mode: 'active', outcome: 'fire', revision, condition: { kind: 'forecast', underMin: 3, includeApps: [] },
  target: { key: 'k', kind: 'group', groupKey: 'g', label: 'l', memKB: GB, targets: [{ pid, startTicks: pid * 10 }], names: ['node'], memKBs: [GB], excluded: 0 },
});

function setup(procs: ProcSample[], over: Partial<RuleRunnerDeps> = {}) {
  const { db } = openHistoryDb(join(mkdtempSync(join(tmpdir(), 'pw-rrs-')), 'm.db'));
  const kill = vi.fn<KillFn>();
  const timers: (() => void)[] = [];
  const notify = vi.fn<(e: AlertEvent) => void>();
  const logs: string[] = [];
  const runner = createRuleRunner({
    db, kill, readProcs: () => procs, selfPid: 900, currentUid: 1000, appRoot: null, isProtected: () => false, notify,
    setTimeout: (fn) => timers.push(fn), now: () => 1_000_000, log: (m) => logs.push(m), claudeDirs: ['/home/u/.claude'], ruleRevision: () => 'rev-1', ...over,
  });
  return { runner, kill, timers, notify, logs, db };
}

describe('M-1 : appartenance à Claude revérifiée avant le signal', () => {
  test('R1 outil Claude détaché (dossier de travail sous ~/.claude, sans ancêtre claude) → refusé', () => {
    const s = setup([...base, P(777, 500, 'node', { cwd: '/home/u/.claude/plugins/x' })]);
    s.runner.run([fire()]);
    expect(s.kill).not.toHaveBeenCalled();
  });
  test('descendant d’un processus travaillant sous ~/.claude → refusé', () => {
    const s = setup([...base, P(770, 500, 'node', { cwd: '/home/u/.claude' }), P(777, 770, 'node', { cwd: '/home/u/acme' })]);
    s.runner.run([fire()]);
    expect(s.kill).not.toHaveBeenCalled();
  });
  test('membre du groupe Claude du dernier instantané → refusé', () => {
    const s = setup([...base, P(777, 500, 'node')], { claudePids: () => new Set([777]) });
    s.runner.run([fire()]);
    expect(s.kill).not.toHaveBeenCalled();
  });
  test('R2 exec en « claude » (même pid + startTicks) entre décision et signal → refusé', () => {
    const s = setup([...base, P(777, 500, 'claude')]);
    s.runner.run([fire()]);
    expect(s.kill).not.toHaveBeenCalled();
  });
  test('cas témoin : processus ordinaire → SIGTERM', () => {
    const s = setup([...base, P(777, 500, 'node', { cwd: '/home/u/acme' })]);
    s.runner.run([fire()]);
    expect(s.kill.mock.calls).toEqual([[777, 'SIGTERM']]);
  });
});

describe('M-2 : ancêtre absent de la lecture → refus', () => {
  test('R6 parent (claude) disparu de la lecture : l’enfant n’est pas gardé', () => {
    const procs = [...base, P(700, 610, 'node', { cmdline: 'node vitest' })];
    const r = filterTargets([700], { byPid: new Map(procs.map((p) => [p.pid, p])), currentUid: 1000, selfPid: 900, appRoot: null, isProtected: () => false });
    expect(r.kept).toEqual([]);
    expect(r.refused.get(700)).toBe('unknown');
  });
  test('runner : aucun kill', () => {
    const s = setup([...base, P(777, 610, 'node')]);
    s.runner.run([fire()]);
    expect(s.kill).not.toHaveBeenCalled();
  });
});

describe('I-5 : le SIGKILL en attente revérifie la règle et l’interrupteur', () => {
  const cases: [string, string | null][] = [
    ['interrupteur général éteint', null],
    ['règle supprimée', null],
    ['règle repassée en Simulation', null],
    ['règle désactivée', null],
    ['règle modifiée (autre révision)', 'rev-2'],
  ];
  test.each(cases)('%s → aucun SIGKILL', (_label, rev) => {
    let current: string | null = 'rev-1';
    const s = setup([...base, P(777, 500, 'node')], { ruleRevision: () => current });
    s.runner.run([fire()]);
    expect(s.kill.mock.calls).toEqual([[777, 'SIGTERM']]);
    current = rev;
    s.timers[0]!();
    expect(s.kill.mock.calls).toEqual([[777, 'SIGTERM']]);
    expect(s.logs.some((l) => /SIGKILL annulé/.test(l))).toBe(true);
    expect(s.runner.pendingEscalations()).toBe(0);
  });
  test('règle inchangée, toujours active → SIGKILL', () => {
    const s = setup([...base, P(777, 500, 'node')], { ruleRevision: () => 'rev-1' });
    s.runner.run([fire()]);
    s.timers[0]!();
    expect(s.kill.mock.calls).toEqual([[777, 'SIGTERM'], [777, 'SIGKILL']]);
  });
  test('règle déjà changée avant le SIGTERM → aucun signal', () => {
    const s = setup([...base, P(777, 500, 'node')], { ruleRevision: () => null });
    s.runner.run([fire()]);
    expect(s.kill).not.toHaveBeenCalled();
  });
  test('sans fonction de révision : jamais de signal (échec fermé)', () => {
    const s = setup([...base, P(777, 500, 'node')], { ruleRevision: undefined });
    s.runner.run([fire()]);
    expect(s.kill).not.toHaveBeenCalled();
  });
});

describe('M-6 : une seule notification « quota atteint » par heure pour toutes les règles', () => {
  test('3 règles au quota dans l’heure → 3 événements, 1 notification ; une heure plus tard → de nouveau', () => {
    let mono = 0;
    const s = setup(base, { monoNow: () => mono });
    const q = (id: string): RuleDecision => ({ ruleId: id, ruleName: id, mode: 'active', outcome: 'skip', reason: 'hourly-quota', target: null });
    s.runner.run([q('a'), q('b')]);
    mono += 30 * 60_000;
    s.runner.run([q('c')]);
    expect((s.db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'rule_action'").get() as { n: number }).n).toBe(3);
    expect(s.notify).toHaveBeenCalledTimes(1);
    mono += 31 * 60_000;
    s.runner.run([q('d')]);
    expect(s.notify).toHaveBeenCalledTimes(2);
  });
});

test('n-2 : décision « culprit-protected » → journal « le principal responsable est protégé : rien à arrêter », aucun signal', () => {
  const s = setup([...base, P(777, 500, 'node')]);
  s.runner.run([{ ruleId: 'r', ruleName: 'prévision', mode: 'active', outcome: 'skip', reason: 'culprit-protected', target: null }]);
  expect(s.kill).not.toHaveBeenCalled();
  expect(s.logs).toEqual([expect.stringMatching(/« prévision » : le principal responsable est protégé : rien à arrêter/)]);
});
