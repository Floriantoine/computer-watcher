import { expect, test } from 'vitest';
import type { ProcSample } from './types';
import { MAX_KILL_TARGETS, killRequest, planKill, sendSignals } from './kill';

const p = (pid: number, ppid: number, uid = 1000): ProcSample => ({
  pid, ppid, name: 'x', cmdline: 'x', uid, startTicks: 0, ageSec: 0, cpuTicks: 0, rssKB: 0, swapKB: 0, cwd: null, cwdDeleted: false,
});

// 1 systemd → 10 warp → 11 zsh → 50 proc-watch (self) → 51 renderer
//                     → 12 zsh → 20 node → 21 esbuild
const tree = [p(1, 0, 0), p(10, 1), p(11, 10), p(50, 11), p(51, 50), p(12, 10), p(20, 12), p(21, 20), p(30, 1, 33)];
const T = (pids: number[]) => pids.map((pid) => ({ pid, startTicks: 0 }));
const guards = { selfPid: 50, currentUid: 1000 };

test('ordre : les enfants avant les parents', () => {
  expect(planKill(T([12, 20, 21]), tree, guards).ordered).toEqual([21, 20, 12]);
});

test('refuse l\'app, ses ancêtres, ses descendants et le PID 1, tue le reste', () => {
  const r = planKill(T([1, 10, 11, 12, 50, 51]), tree, guards);
  expect(r.ordered).toEqual([12]);
  expect(r.refused.map((x) => [x.pid, x.error])).toEqual([[1, 'SELF'], [10, 'SELF'], [11, 'SELF'], [50, 'SELF'], [51, 'SELF']]);
});

test('refuse les processus d\'un autre utilisateur', () => {
  expect(planKill(T([30]), tree, guards).refused).toEqual([{ pid: 30, ok: false, error: 'EPERM' }]);
});

test('PID inconnu → ESRCH, doublons ignorés', () => {
  const r = planKill(T([999, 20, 20]), tree, guards);
  expect(r.refused).toEqual([{ pid: 999, ok: false, error: 'ESRCH' }]);
  expect(r.ordered).toEqual([20]);
});

test('sendSignals renvoie le code errno de chaque échec', () => {
  const sent: [number, string][] = [];
  const kill = (pid: number, sig: string) => {
    if (pid === 2) throw Object.assign(new Error('x'), { code: 'ESRCH' });
    sent.push([pid, sig]);
  };
  expect(sendSignals([3, 2], 'SIGTERM', kill)).toEqual([{ pid: 3, ok: true }, { pid: 2, ok: false, error: 'ESRCH' }]);
  expect(sent).toEqual([[3, 'SIGTERM']]);
});

test('fail closed : selfPid absent du snapshot → tout refusé SELF', () => {
  const r = planKill(T([12, 20]), tree.filter((x) => x.pid !== 50), guards);
  expect(r.ordered).toEqual([]);
  expect(r.refused).toEqual([{ pid: 12, ok: false, error: 'SELF' }, { pid: 20, ok: false, error: 'SELF' }]);
});

test('fail closed : chaîne d\'ancêtres cassée → tout refusé SELF', () => {
  const broken = tree.filter((x) => x.pid !== 10 && x.pid !== 1);
  const r = planKill(T([12, 20]), broken, guards);
  expect(r.ordered).toEqual([]);
  expect(r.refused.map((x) => x.error)).toEqual(['SELF', 'SELF']);
});

test('un descendant à deux niveaux est refusé', () => {
  const t = [...tree, p(52, 51)];
  expect(planKill(T([52]), t, guards).refused).toEqual([{ pid: 52, ok: false, error: 'SELF' }]);
});

test('un frère de l\'app (même parent) est autorisé', () => {
  const t = [...tree, p(60, 11)];
  expect(planKill(T([60]), t, guards).ordered).toEqual([60]);
});

test('parent donné avant l\'enfant → enfant en premier', () => {
  expect(planKill(T([12, 20]), tree, guards).ordered).toEqual([20, 12]);
});

test('sendSignals refuse les PID invalides sans appeler kill', () => {
  const kill = () => { throw new Error('ne doit pas être appelé'); };
  expect(sendSignals([0, -1, 1.5, 1], 'SIGTERM', kill)).toEqual(
    [0, -1, 1.5, 1].map((pid) => ({ pid, ok: false, error: 'EINVAL' })),
  );
});

test('ppid NaN dans la chaîne → fail closed, tout refusé SELF', () => {
  const t = tree.map((x) => (x.pid === 50 ? { ...x, ppid: NaN } : x));
  const r = planKill(T([12, 20]), t, guards);
  expect(r.ordered).toEqual([]);
  expect(r.refused.map((x) => x.error)).toEqual(['SELF', 'SELF']);
});

test('ppid négatif dans la chaîne → fail closed', () => {
  const t = tree.map((x) => (x.pid === 11 ? { ...x, ppid: -4 } : x));
  expect(planKill(T([12]), t, guards).refused.map((x) => x.error)).toEqual(['SELF']);
});

test('startTicks différent (PID réutilisé) → ESRCH, non tué', () => {
  const t = tree.map((x) => (x.pid === 20 ? { ...x, startTicks: 777 } : x));
  const r = planKill([{ pid: 20, startTicks: 5 }, { pid: 21, startTicks: 0 }], t, guards);
  expect(r.ordered).toEqual([21]);
  expect(r.refused).toEqual([{ pid: 20, ok: false, error: 'ESRCH' }]);
});

test('startTicks identique → autorisé', () => {
  const t = tree.map((x) => (x.pid === 20 ? { ...x, startTicks: 777 } : x));
  expect(planKill([{ pid: 20, startTicks: 777 }], t, guards).ordered).toEqual([20]);
});

test('killRequest : valide la requête du renderer, lève une erreur au-delà de 2 000 cibles', () => {
  expect(MAX_KILL_TARGETS).toBe(2000);
  expect(killRequest([{ pid: 5, startTicks: 7, extra: 1 }], 'SIGTERM')).toEqual({ targets: [{ pid: 5, startTicks: 7 }], signal: 'SIGTERM' });
  expect(killRequest([{ pid: 5 }], 'SIGTERM')).toBeNull();
  expect(killRequest('x', 'SIGTERM')).toBeNull();
  expect(killRequest([], 'SIGHUP')).toBeNull();
  const max = Array.from({ length: 2000 }, (_, i) => ({ pid: i + 2, startTicks: 0 }));
  expect(killRequest(max, 'SIGKILL')?.targets).toHaveLength(2000);
  expect(() => killRequest([...max, { pid: 9999, startTicks: 0 }], 'SIGTERM')).toThrow('Trop de cibles (2 000 au plus)');
});
