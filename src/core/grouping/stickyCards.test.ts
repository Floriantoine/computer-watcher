import { describe, expect, test } from 'vitest';
import type { ProcInfo } from '../types';
import { buildGroups, isOverThreshold } from './buildGroups';
import { stickyIds, recordSeparate } from './stickyCards';

const g = (id: string, kind = 'command') => ({ id, kind });

test('un groupe affiché à part le reste HOLD ms après être repassé sous les seuils, puis est oublié', () => {
  const seen = new Map<string, number>();
  recordSeparate(seen, [g('command:a'), g('command:small'), g('others', 'others')], 1000, (x) => x.id !== 'command:small');
  expect([...seen.keys()]).toEqual(['command:a']);
  expect([...stickyIds(seen, 1000 + 29_999, 30_000)]).toEqual(['command:a']);
  expect([...stickyIds(seen, 1000 + 30_000, 30_000)]).toEqual([]);
  expect(seen.size).toBe(0);
});

describe('intégration avec buildGroups', () => {
  const T = { memMB: 100, cpuPercent: 1 };
  const proc = (pid: number, name: string, cpuPercent = 0): ProcInfo => ({
    pid, ppid: 1, name, cmdline: name, uid: 1000, startTicks: pid, ageSec: 100, cpuTicks: 0, cpuPercent,
    rssKB: 1024, swapKB: 0, cwd: null, cwdDeleted: false,
  });
  const run = (seen: Map<string, number>, now: number, procs: ProcInfo[], t = T) => {
    const sticky = stickyIds(seen, now, 30_000);
    const groups = buildGroups(procs, { home: '/h', currentUid: 1000, isProtected: () => false, othersThreshold: t, projectRootOf: () => null, keepSeparate: (id) => sticky.has(id) });
    recordSeparate(seen, groups, now, (g) => isOverThreshold(g, t));
    return groups.map((g) => g.id);
  };
  const calm = [proc(1, 'a'), proc(2, 'b'), proc(3, 'c')];

  test('un pic CPU unique : carte à part 30 s, puis retour dans Autres', () => {
    const seen = new Map<string, number>();
    expect(run(seen, 0, calm)).toEqual(['others']);
    expect(run(seen, 2_000, [proc(1, 'a', 5), proc(2, 'b'), proc(3, 'c')])).toContain('command:a');
    for (let t = 4_000; t < 32_000; t += 2_000) expect(run(seen, t, calm)).toContain('command:a');
    expect(run(seen, 32_000, calm)).toEqual(['others']);
    expect(run(seen, 34_000, calm)).toEqual(['others']);
  });

  test('le dernier petit groupe laissé seul par l\'hystérésis ne devient pas collant', () => {
    const seen = new Map<string, number>();
    const two = [proc(1, 'a'), proc(2, 'b')];
    run(seen, 0, [proc(1, 'a', 5), proc(2, 'b')]); // a au-dessus ; b seul petit → à part, mais pas noté
    expect([...seen.keys()]).toEqual(['command:a']);
    for (let t = 2_000; t < 32_000; t += 2_000) run(seen, t, two);
    expect(run(seen, 32_000, two)).toEqual(['others']);
  });

  test('seuils relevés : les groupes repassent dans Autres en 30 s', () => {
    const seen = new Map<string, number>();
    const big = [proc(1, 'a', 5), proc(2, 'b', 5), proc(3, 'c')];
    expect(run(seen, 0, big)).toEqual(expect.arrayContaining(['command:a', 'command:b']));
    const raised = { memMB: 100, cpuPercent: 50 };
    expect(run(seen, 2_000, big, raised)).toEqual(expect.arrayContaining(['command:a', 'command:b']));
    expect(run(seen, 30_000, big, raised)).toEqual(['others']);
  });
});
