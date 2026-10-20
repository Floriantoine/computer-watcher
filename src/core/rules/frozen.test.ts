// Anti-gel lot 3 : un processus « au frigo » (gelé) n'est jamais visé par une règle automatique.
import { expect, test } from 'vitest';
import { group, node, proc } from '../classify/testFixtures';
import type { GroupClassification } from '../classify/classify';
import type { Group, ProcInfo, ProcNode } from '../types';
import { emptyRuleState, evaluateRules, type EvalInput } from './engine';
import { filterTargets, type GuardProc } from './neverKill';

const procs: GuardProc[] = [
  { pid: 500, ppid: 1, name: 'systemd', cmdline: 'systemd --user', uid: 1000 },
  { pid: 600, ppid: 500, name: 'warp', cmdline: 'warp', uid: 1000 },
  { pid: 601, ppid: 600, name: 'zsh', cmdline: 'zsh', uid: 1000 },
  { pid: 602, ppid: 601, name: 'node', cmdline: 'node vitest', uid: 1000 },
  { pid: 603, ppid: 602, name: 'node', cmdline: 'node worker', uid: 1000 },
  { pid: 604, ppid: 601, name: 'node', cmdline: 'node server', uid: 1000 },
];
const ctx = (frozen?: Set<number>) => ({ byPid: new Map(procs.map((p) => [p.pid, p])), currentUid: 1000, selfPid: 900, appRoot: null, isProtected: () => false, frozen });

test('filterTargets : gelé → refusé « frozen », son lanceur aussi ; sans frigo, inchangé', () => {
  expect(filterTargets([602, 603, 604], ctx()).kept).toEqual([602, 603, 604]);
  const r = filterTargets([602, 603, 604], ctx(new Set([603])));
  expect(r.kept).toEqual([604]);
  expect(Object.fromEntries(r.refused)).toEqual({ 602: 'launcher', 603: 'frozen' });
});

test('règle « inactif depuis T » : un serveur au frigo (0 % de CPU) n’est pas visé', () => {
  const sysd = proc('systemd', 'systemd --user', { pid: 500, ppid: 1 });
  const me = proc('node', 'node /x/out/main/recorder.js', { pid: 900, ppid: 500 });
  const srv = proc('node', 'node /home/u/demo/server.js', { pid: 700, ppid: 500, startTicks: 7000, rssKB: 500_000, ageSec: 7200 });
  const srvNode: ProcNode = node(srv);
  const g: Group = group('project:/home/u/demo', 'project', [srvNode]);
  g.label = 'demo';
  const svc = group('command:systemd', 'command', [node(sysd, node(me))]);
  const all: ProcInfo[] = [srv];
  const classification = new Map<string, GroupClassification>([[g.id, {
    categories: ['back'], launcherPids: [],
    instances: [{
      key: `${g.id}#700:7000`, groupId: g.id, project: '/home/u/demo', category: 'back', source: 'command', signature: 'server', label: 'server',
      rootPid: 700, rootStartTicks: 7000, pids: all.map((p) => p.pid), ports: [], ageSec: 7200, rssKB: 500_000, swapKB: 0, cpuPercent: 0, duplicate: false, protected: false,
    }],
  }]]);
  const base: EvalInput = {
    now: 10 * 3600_000, enabled: true, groups: [svc, g], classification, forecast: null, procGrowthKB: null,
    rules: [{ id: 'r-i', name: 'inactifs', enabled: true, mode: 'simulate', createdAt: 0, condition: { kind: 'inactive', categories: ['back'], forHours: 1 } }],
    inactive: () => new Set<string>(), isProtected: () => false, appRoot: null, currentUid: 1000, selfPid: 900,
  };
  const fired = (i: EvalInput) => evaluateRules(i, emptyRuleState()).filter((d) => d.outcome === 'fire');
  expect(fired(base)).toHaveLength(1);
  expect(fired({ ...base, frozenPids: new Set([700]) })).toHaveLength(0);
});
