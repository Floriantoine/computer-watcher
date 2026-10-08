import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { makeProcRoot } from './fakeProc';
import { readSystem } from './readSystem';

function withSystemFiles(psi: boolean): string {
  const root = makeProcRoot();
  writeFileSync(join(root, 'meminfo'), 'MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 2000 kB\nSwapFree: 500 kB\nShmem: 250 kB\n');
  writeFileSync(join(root, 'loadavg'), '3.50 2.00 1.00 1/100 999\n');
  if (psi) {
    mkdirSync(join(root, 'pressure'));
    writeFileSync(join(root, 'pressure', 'memory'), 'some avg10=12.50 avg60=0 avg300=0 total=0\n');
  }
  return root;
}

test('lit mémoire, charge et PSI', () => {
  expect(readSystem(withSystemFiles(true))).toEqual({ memTotalKB: 1000, memAvailableKB: 400, swapTotalKB: 2000, swapFreeKB: 500, load1: 3.5, psiSome10: 12.5, shmemKB: 250 });
});

test('PSI absent → null', () => {
  expect(readSystem(withSystemFiles(false)).psiSome10).toBeNull();
});
