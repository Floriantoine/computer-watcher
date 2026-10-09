import { expect, test } from 'vitest';
import { DISK_LOW_HOLD_MS, diskThresholdKB, initialDiskAlertState, shouldRecordDiskLow, type DiskAlertState, type DiskStat } from './alert';

const GB = 1024 * 1024;

test('seuil : max(pourcentage de la taille, n Go)', () => {
  expect(diskThresholdKB(477 * GB, 10, 20)).toBe(47.7 * GB);
  expect(diskThresholdKB(100 * GB, 10, 20)).toBe(20 * GB);
});

const size = 477 * GB;
const threshold = diskThresholdKB(size, 10, 20);
const at = (availGB: number): DiskStat => ({ mount: '/', sizeKB: size, availKB: availGB * GB });

/** Rejoue une suite (instant en s, Go libres) et renvoie les instants où un événement est enregistré. */
function play(steps: [number, number][], st: DiskAlertState = initialDiskAlertState(null, 0)): number[] {
  const out: number[] = [];
  for (const [s, gb] of steps) {
    const r = shouldRecordDiskLow(at(gb), threshold, st, s * 1000);
    if (r.record) out.push(s);
    st = r.state;
  }
  return out;
}

test('sous le seuil moins de 60 s : rien ; tenu 60 s : un événement, puis plus rien', () => {
  expect(DISK_LOW_HOLD_MS).toBe(60_000);
  expect(play([[0, 15], [30, 15], [59, 15]])).toEqual([]);
  expect(play([[0, 15], [30, 15], [60, 15], [90, 15], [600, 14], [3600, 10]])).toEqual([60]);
});

test('repasse au-dessus du seuil avant 60 s : la tenue repart de zéro', () => {
  expect(play([[0, 15], [40, 60], [50, 15], [100, 15], [110, 15]])).toEqual([110]);
});

test('réarmée seulement au-dessus du seuil + 5 % de la taille', () => {
  const rearm = threshold / GB + 0.05 * 477 + 1; // au-dessus du seuil + 5 %
  expect(play([[0, 15], [60, 15], [100, rearm], [200, 15], [260, 15]])).toEqual([60, 260]);
});

test('oscillation autour du seuil sans dépasser + 5 % : un seul événement', () => {
  const justAbove = threshold / GB + 1;
  const steps: [number, number][] = [];
  for (let i = 0; i < 40; i++) steps.push([i * 61, i % 2 ? justAbove : 15], [i * 61 + 60, 15]);
  expect(play(steps.sort((a, b) => a[0] - b[0]))).toHaveLength(1);
});

test('après un redémarrage du service avec une alerte récente : pas de doublon tant que non réarmée', () => {
  expect(play([[0, 15], [60, 15], [120, 15]], initialDiskAlertState(-10_000, 0))).toEqual([]);
  // réarmée par un passage au-dessus du seuil + 5 %
  expect(play([[0, 200], [10, 15], [70, 15]], initialDiskAlertState(-10_000, 0))).toEqual([70]);
});

test('alerte enregistrée il y a plus de 24 h avant le redémarrage : armée', () => {
  expect(initialDiskAlertState(0, 24 * 3600_000).armed).toBe(true);
  expect(initialDiskAlertState(0, 3600_000).armed).toBe(false);
});
