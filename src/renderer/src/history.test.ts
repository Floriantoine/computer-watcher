import { expect, test } from 'vitest';
import { LiveBuffer, onLiveResume, setLive } from './history';

const sys = (mem: number) => ({ memTotalKB: 100, memAvailableKB: 100 - mem, swapTotalKB: 10, swapFreeKB: 10, load1: 1, psiSome10: 0, shmemKB: 0 });

test('LiveBuffer garde 30 min et les séries par groupe', () => {
  const b = new LiveBuffer(30 * 60_000);
  b.push(0, sys(10), [{ id: 'a', rssKB: 5, swapKB: 1 }]);
  b.push(60_000, sys(20), [{ id: 'a', rssKB: 7, swapKB: 1 }, { id: 'b', rssKB: 1, swapKB: 0 }]);
  expect(b.system().map((p) => p.memUsedKB)).toEqual([10, 20]);
  expect(b.group('a')).toEqual([6, 8]);
  expect(b.group('b')).toEqual([1]);
  b.push(31 * 60_000, sys(30), []);
  expect(b.system().map((p) => p.memUsedKB)).toEqual([20, 30]);
});

test('procSparkMap : séries indexées par pid:startTicks', async () => {
  const { procSparkMap } = await import('./history');
  const m = procSparkMap({ ts: [1, 2], series: [{ pid: 4, startTicks: 99, memKB: [1, 2] }] });
  expect(m.get('4:99')).toEqual([1, 2]);
  expect(procSparkMap(null).size).toBe(0);
});

test('reprise de la collecte en direct : les abonnés sont prévenus une fois par reprise', () => {
  let n = 0;
  const off = onLiveResume(() => n++);
  setLive(true);
  expect(n).toBe(0); // déjà en direct : pas une reprise
  setLive(false);
  setLive(true);
  setLive(true);
  expect(n).toBe(1);
  off();
  setLive(false);
  setLive(true);
  expect(n).toBe(1);
});
