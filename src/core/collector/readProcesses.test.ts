import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { addProc, makeProcRoot } from './fakeProc';
import { readProcesses } from './readProcesses';

test('lit un processus complet', () => {
  const root = makeProcRoot(1000);
  addProc(root, { pid: 42, comm: 'node', ppid: 7, uid: 1000, utime: 300, stime: 100, starttime: 40000, rssKB: 2048, swapKB: 512, cmdline: ['node', 'vite', '--port', '5173'], cwd: '/home/u/proj' });
  expect(readProcesses(root)).toEqual([
    { pid: 42, ppid: 7, name: 'node', cmdline: 'node vite --port 5173', uid: 1000, startTicks: 40000, ageSec: 600, cpuTicks: 400, rssKB: 2048, swapKB: 512, cwd: '/home/u/proj', cwdDeleted: false },
  ]);
});

test('détecte un dossier de travail supprimé', () => {
  const root = makeProcRoot();
  addProc(root, { pid: 5, comm: 'node', rssKB: 1, cwd: '/home/u/old-worktree (deleted)' });
  const [p] = readProcesses(root);
  expect(p.cwd).toBe('/home/u/old-worktree');
  expect(p.cwdDeleted).toBe(true);
});

test('cwd illisible → null', () => {
  const root = makeProcRoot();
  addProc(root, { pid: 5, comm: 'sshd', uid: 0, rssKB: 1, cwd: null });
  expect(readProcesses(root)[0].cwd).toBeNull();
});

test('thread noyau : cmdline vide → [nom], RSS 0', () => {
  const root = makeProcRoot();
  addProc(root, { pid: 3, comm: 'kworker/0:1', uid: 0, cmdline: [] });
  const [p] = readProcesses(root);
  expect(p.cmdline).toBe('[kworker/0:1]');
  expect(p.rssKB).toBe(0);
});

test('processus disparu pendant la lecture → ignoré, les autres sont lus', () => {
  const root = makeProcRoot();
  addProc(root, { pid: 10, comm: 'gone', partial: true });
  addProc(root, { pid: 11, comm: 'alive', rssKB: 1 });
  expect(readProcesses(root).map((p) => p.pid)).toEqual([11]);
});

test('ignore les entrées non numériques de /proc', () => {
  const root = makeProcRoot();
  mkdirSync(join(root, 'self'));
  writeFileSync(join(root, 'meminfo'), '');
  addProc(root, { pid: 11, comm: 'alive', rssKB: 1 });
  expect(readProcesses(root)).toHaveLength(1);
});
