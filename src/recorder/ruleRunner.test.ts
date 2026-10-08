// Exécution des règles : aucun vrai signal (kill espion ou qui lève), faux readProcs, faux setTimeout.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { AlertEvent } from '../core/alerts';
import { openHistoryDb } from '../core/history/db';
import { ruleEventsSince } from '../core/history/events';
import type { KillFn } from '../core/kill';
import { restoreRuleState, type RuleDecision, type RuleTarget } from '../core/rules/engine';
import type { ProcSample } from '../core/types';
import { createRuleRunner, ESCALATE_MS, serviceKill, type RuleRunnerDeps } from './ruleRunner';

const GB = 1024 * 1024;
const ps = (pid: number, ppid: number, name: string, over: Partial<ProcSample> = {}): ProcSample => ({
  pid, ppid, name, cmdline: name, uid: 1000, startTicks: pid * 10, ageSec: 100, cpuTicks: 0, rssKB: GB, swapKB: 0, cwd: null, cwdDeleted: false, ...over,
});
// chaîne du service : 1 → 500 (systemd --user) → 900 (service)
const base = [ps(1, 0, 'systemd', { uid: 0 }), ps(500, 1, 'systemd', { cmdline: 'systemd --user' }), ps(900, 500, 'node', { cmdline: 'node /x/out/main/recorder.js' })];
const vitest = ps(700, 500, 'node', { cmdline: 'node vitest', startTicks: 7000, rssKB: 4.3 * GB });

const target = (over: Partial<RuleTarget> = {}): RuleTarget => ({
  key: 'project:/home/u/acme#700:7000', kind: 'instance', groupKey: 'project:/home/u/acme', label: 'vitest (acme)', memKB: 4.3 * GB,
  targets: [{ pid: 700, startTicks: 7000 }], names: ['node'], memKBs: [4.3 * GB], excluded: 0, ...over,
});
const fire = (mode: 'simulate' | 'active', t: RuleTarget = target(), ruleId = 'r-a'): RuleDecision => ({
  ruleId, ruleName: 'vitest > 4 Go', mode, outcome: 'fire', target: t, revision: 'rev',
  condition: { kind: 'memory', target: 'instance', match: { by: 'name', value: 'vitest' }, overMB: 4096, forMin: 5 },
});

function setup(o: { procs?: ProcSample[][]; kill?: KillFn } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pw-rr-'));
  const { db } = openHistoryDb(join(dir, 'metrics.db'));
  const snapshots = o.procs ?? [[...base, vitest]];
  let call = 0;
  const readProcs = vi.fn(() => snapshots[Math.min(call++, snapshots.length - 1)]!);
  const kill = vi.fn<KillFn>(o.kill ?? (() => {}));
  const timers: { fn: () => void; ms: number }[] = [];
  const notify = vi.fn<(e: AlertEvent) => void>();
  const log = vi.fn<(m: string) => void>();
  const deps: RuleRunnerDeps = {
    db, kill, readProcs, selfPid: 900, currentUid: 1000, appRoot: null, isProtected: () => false, notify,
    setTimeout: (fn, ms) => timers.push({ fn, ms }), now: () => 1_000_000, log, ruleRevision: () => 'rev',
  };
  const runner = createRuleRunner(deps);
  const events = () =>
    (db.prepare('SELECT type, detail FROM events ORDER BY id').all() as { type: string; detail: string }[]).map((e) => ({ type: e.type, ...JSON.parse(e.detail) }));
  return { runner, kill, readProcs, timers, notify, log, events, db };
}

describe('Simulation', () => {
  test('50 décisions fire/simulate aléatoires → kill et readProcs jamais appelés, 50 événements rule_dry_run', () => {
    const s = setup({ kill: () => { throw new Error('kill appelé en simulation'); } });
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const ds: RuleDecision[] = Array.from({ length: 50 }, (_, i) => {
      const n = 1 + Math.floor(rnd() * 5);
      const pids = Array.from({ length: n }, () => 2 + Math.floor(rnd() * 100_000));
      return fire('simulate', target({
        key: `k${i}`, label: `cible ${i}`, memKB: Math.floor(rnd() * 10 * GB),
        targets: pids.map((pid) => ({ pid, startTicks: Math.floor(rnd() * 1e9) })), names: pids.map(() => 'node'), memKBs: pids.map(() => 1000),
      }), `r-${i % 7}`);
    });
    s.runner.run(ds);
    expect(s.kill).not.toHaveBeenCalled();
    expect(s.readProcs).not.toHaveBeenCalled();
    expect(s.timers).toEqual([]);
    const ev = s.events();
    expect(ev).toHaveLength(50);
    expect(ev.every((e) => e.type === 'rule_dry_run' && e.result === 'dry_run')).toBe(true);
    expect(s.runner.pendingEscalations()).toBe(0);
  });

  test('événement rule_dry_run : règle, cibles (nom, pid, mémoire), résultat', () => {
    const s = setup();
    s.runner.run([fire('simulate')]);
    expect(s.events()).toEqual([{
      type: 'rule_dry_run', ruleId: 'r-a', rule: 'vitest > 4 Go', target: 'vitest (acme)', memKB: 4.3 * GB, pids: [700],
      targets: [{ name: 'node', pid: 700, memKB: 4.3 * GB }], result: 'dry_run',
    }]);
    expect(s.notify).toHaveBeenCalledTimes(1);
    expect(s.notify.mock.calls[0]![0]).toMatchObject({ type: 'rule_dry_run' });
    expect(s.kill).not.toHaveBeenCalled();
  });
});

describe('Active', () => {
  test('SIGTERM au pid de la cible, événement sigterm, notification ; 5 s plus tard, encore là → SIGKILL', () => {
    const s = setup();
    s.runner.run([fire('active')]);
    expect(s.kill.mock.calls).toEqual([[700, 'SIGTERM']]);
    expect(s.events()).toEqual([expect.objectContaining({ type: 'rule_action', result: 'sigterm', signal: 'SIGTERM', killed: 1, refused: [], targets: [{ name: 'node', pid: 700, memKB: 4.3 * GB }] })]);
    expect(s.notify).toHaveBeenCalledTimes(1);
    expect(s.notify.mock.calls[0]![0]).toMatchObject({ type: 'rule_action', detail: { result: 'sigterm' } });
    expect(s.timers.map((t) => t.ms)).toEqual([ESCALATE_MS]);
    expect(s.runner.pendingEscalations()).toBe(1);
    s.timers[0]!.fn();
    expect(s.kill.mock.calls).toEqual([[700, 'SIGTERM'], [700, 'SIGKILL']]);
    expect(s.events()[1]).toMatchObject({ type: 'rule_action', result: 'sigkill', signal: 'SIGKILL', killed: 1 });
    expect(s.runner.pendingEscalations()).toBe(0);
  });

  test('processus parti avant l’escalade → aucun SIGKILL', () => {
    const s = setup({ procs: [[...base, vitest], [...base]] });
    s.runner.run([fire('active')]);
    s.timers[0]!.fn();
    expect(s.kill.mock.calls).toEqual([[700, 'SIGTERM']]);
    expect(s.events()).toHaveLength(1);
  });

  test('PID réutilisé avant le SIGTERM (autre startTicks) → aucun kill, événement refused ESRCH', () => {
    const s = setup({ procs: [[...base, { ...vitest, startTicks: 99_999 }]] });
    s.runner.run([fire('active')]);
    expect(s.kill).not.toHaveBeenCalled();
    expect(s.events()).toEqual([expect.objectContaining({ type: 'rule_action', result: 'refused', killed: 0, refused: [{ pid: 700, error: 'ESRCH' }] })]);
    expect(s.timers).toEqual([]);
  });

  test('PID réutilisé avant l’escalade → aucun SIGKILL', () => {
    const s = setup({ procs: [[...base, vitest], [...base, { ...vitest, startTicks: 99_999 }]] });
    s.runner.run([fire('active')]);
    s.timers[0]!.fn();
    expect(s.kill.mock.calls).toEqual([[700, 'SIGTERM']]);
  });

  test('soi-même ou un ancêtre → refusé ; chaîne d’ancêtres inconnue → tout refusé (fail closed)', () => {
    const s = setup();
    s.runner.run([fire('active', target({ targets: [{ pid: 900, startTicks: 9000 }, { pid: 500, startTicks: 5000 }], names: ['node', 'systemd'], memKBs: [1, 1] }))]);
    expect(s.kill).not.toHaveBeenCalled();
    const s2 = setup({ procs: [[base[2]!, vitest]] }); // 500 absent : chaîne inconnue
    s2.runner.run([fire('active')]);
    expect(s2.kill).not.toHaveBeenCalled();
    expect(s2.events()[0]).toMatchObject({ result: 'refused', refused: [{ pid: 700, error: 'GUARD:unknown' }] });
  });

  test('autre uid → EPERM, aucun kill', () => {
    const s = setup({ procs: [[...base, { ...vitest, uid: 1001 }]] });
    s.runner.run([fire('active')]);
    expect(s.kill).not.toHaveBeenCalled();
    expect(s.events()[0]!.refused).toEqual([{ pid: 700, error: 'GUARD:uid' }]);
  });

  test('liste « jamais tuer » revérifiée juste avant le signal : pid devenu un zsh, ou descendant de claude, ou protégé → aucun kill', () => {
    const asZsh = setup({ procs: [[...base, { ...vitest, name: 'zsh', cmdline: 'zsh' }]] });
    asZsh.runner.run([fire('active')]);
    expect(asZsh.kill).not.toHaveBeenCalled();
    expect(asZsh.events()[0]!.refused).toEqual([{ pid: 700, error: 'GUARD:never-kill' }]);

    const underClaude = setup({ procs: [[...base, ps(650, 500, 'claude'), { ...vitest, ppid: 650 }]] });
    underClaude.runner.run([fire('active')]);
    expect(underClaude.kill).not.toHaveBeenCalled();
    expect(underClaude.events()[0]!.refused).toEqual([{ pid: 700, error: 'GUARD:claude' }]);

    const prot = setup();
    const r = createRuleRunner({
      db: prot.db, kill: prot.kill, readProcs: prot.readProcs, selfPid: 900, currentUid: 1000, appRoot: null, isProtected: (n) => n === 'node',
      notify: prot.notify, setTimeout: () => 0, now: () => 1, log: () => {}, ruleRevision: () => 'rev',
    });
    r.run([fire('active')]);
    expect(prot.kill).not.toHaveBeenCalled();
  });

  test('revérification aussi avant le SIGKILL : processus devenu protégé entre-temps → aucun SIGKILL', () => {
    let protectedNames: string[] = [];
    const s = setup();
    const r = createRuleRunner({
      db: s.db, kill: s.kill, readProcs: s.readProcs, selfPid: 900, currentUid: 1000, appRoot: null, isProtected: (n) => protectedNames.includes(n),
      notify: s.notify, setTimeout: (fn, ms) => s.timers.push({ fn, ms }), now: () => 1, log: () => {}, ruleRevision: () => 'rev',
    });
    r.run([fire('active')]);
    protectedNames = ['node'];
    s.timers[0]!.fn();
    expect(s.kill.mock.calls).toEqual([[700, 'SIGTERM']]);
  });

  test('quota → un événement « quota » et une notification ; cooldown → rien ; guard → journal « rien à arrêter »', () => {
    const s = setup();
    s.runner.run([
      { ruleId: 'r-a', ruleName: 'A', mode: 'active', outcome: 'skip', reason: 'hourly-quota', target: target() },
      { ruleId: 'r-b', ruleName: 'B', mode: 'active', outcome: 'skip', reason: 'cooldown', target: target() },
      { ruleId: 'r-c', ruleName: 'C', mode: 'simulate', outcome: 'skip', reason: 'guard', target: target({ targets: [], names: [], memKBs: [], excluded: 2 }) },
    ]);
    expect(s.kill).not.toHaveBeenCalled();
    expect(s.events()).toEqual([expect.objectContaining({ type: 'rule_action', ruleId: 'r-a', result: 'quota' })]);
    expect(s.notify).toHaveBeenCalledTimes(1);
    expect(s.log.mock.calls.map((c) => c[0])).toEqual([expect.stringMatching(/« C ».*rien à arrêter/)]);
  });
});

test('serviceKill({ PROC_WATCH_NO_KILL: "1" }, real) → real jamais appelé, l’appel échoue en NOKILL', () => {
  const real = vi.fn();
  const k = serviceKill({ PROC_WATCH_NO_KILL: '1' }, real, () => {});
  expect(() => k(700, 'SIGTERM')).toThrow(expect.objectContaining({ code: 'NOKILL' }));
  expect(real).not.toHaveBeenCalled();
  const k2 = serviceKill({}, real);
  k2(700, 'SIGTERM');
  expect(real).toHaveBeenCalledWith(700, 'SIGTERM');
});

test('restoreRuleState : 3 rule_action dans l’heure + 1 il y a 2 h → 3 actions, lastFire = la plus récente ; quota → pause', () => {
  const now = 10 * 3600_000;
  const s = setup();
  const ins = (ts: number, type: string, detail: object) => s.db.prepare('INSERT INTO events(ts, type, group_id, detail) VALUES (?, ?, NULL, ?)').run(ts, type, JSON.stringify(detail));
  ins(now - 2 * 3600_000, 'rule_action', { ruleId: 'r-a', result: 'sigterm' });
  ins(now - 50 * 60_000, 'rule_action', { ruleId: 'r-a', result: 'sigterm' });
  ins(now - 40 * 60_000, 'rule_action', { ruleId: 'r-a', result: 'sigkill' });
  ins(now - 30 * 60_000, 'rule_action', { ruleId: 'r-b', result: 'refused' });
  ins(now - 10 * 60_000, 'rule_action', { ruleId: 'r-a', result: 'sigterm' });
  ins(now - 5 * 60_000, 'rule_dry_run', { ruleId: 'r-c', result: 'dry_run' });
  ins(now - 4 * 60_000, 'rule_action', { ruleId: 'r-d', result: 'quota' });
  ins(now - 3 * 60_000, 'rule_action', { result: 'sigterm' }); // sans ruleId : ignoré
  const st = restoreRuleState(ruleEventsSince(s.db, now - 3600_000), now);
  expect(st.actions).toHaveLength(3);
  expect(st.dryRuns).toHaveLength(1);
  expect(st.lastFire.get('r-a')).toBe(now - 10 * 60_000);
  expect(st.pausedUntil.get('r-d')).toBe(now - 4 * 60_000 + 3600_000);
});
