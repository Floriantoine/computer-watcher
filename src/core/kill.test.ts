import { expect, test } from 'vitest';
import type { ProcSample } from './types';
import { planKill, sendSignals } from './kill';

const p = (pid: number, ppid: number, uid = 1000): ProcSample => ({
  pid, ppid, name: 'x', cmdline: 'x', uid, startTicks: 0, ageSec: 0, cpuTicks: 0, rssKB: 0, swapKB: 0, cwd: null, cwdDeleted: false,
});

// 1 systemd → 10 warp → 11 zsh → 50 proc-watch (self) → 51 renderer
//                     → 12 zsh → 20 node → 21 esbuild
const tree = [p(1, 0, 0), p(10, 1), p(11, 10), p(50, 11), p(51, 50), p(12, 10), p(20, 12), p(21, 20), p(30, 1, 33)];
const guards = { selfPid: 50, currentUid: 1000 };

test('ordre : les enfants avant les parents', () => {
  expect(planKill([12, 20, 21], tree, guards).ordered).toEqual([21, 20, 12]);
});

test('refuse l\'app, ses ancêtres, ses descendants et le PID 1, tue le reste', () => {
  const r = planKill([1, 10, 11, 12, 50, 51], tree, guards);
  expect(r.ordered).toEqual([12]);
  expect(r.refused.map((x) => [x.pid, x.error])).toEqual([[1, 'SELF'], [10, 'SELF'], [11, 'SELF'], [50, 'SELF'], [51, 'SELF']]);
});

test('refuse les processus d\'un autre utilisateur', () => {
  expect(planKill([30], tree, guards).refused).toEqual([{ pid: 30, ok: false, error: 'EPERM' }]);
});

test('PID inconnu → ESRCH, doublons ignorés', () => {
  const r = planKill([999, 20, 20], tree, guards);
  expect(r.refused).toEqual([{ pid: 999, ok: false, error: 'ESRCH' }]);
  expect(r.ordered).toEqual([20]);
});

test('sendSignals renvoie le code errno de chaque échec', () => {
  const sent: [number, string][] = [];
  const kill = (pid: number, sig: string) => {
    if (pid === 2) throw Object.assign(new Error('x'), { code: 'ESRCH' });
    sent.push([pid, sig]);
  };
  expect(sendSignals([1, 2], 'SIGTERM', kill)).toEqual([{ pid: 1, ok: true }, { pid: 2, ok: false, error: 'ESRCH' }]);
  expect(sent).toEqual([[1, 'SIGTERM']]);
});
