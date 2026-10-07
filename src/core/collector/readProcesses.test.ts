import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { addProc, makeProcRoot } from './fakeProc';
import { readProcesses, type CwdEntry, type StatusEntry } from './readProcesses';

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

test('wantCwd : ne lit le cwd que des processus demandés', () => {
  const root = makeProcRoot();
  addProc(root, { pid: 1, comm: 'node', rssKB: 1, cwd: '/home/u/p' });
  addProc(root, { pid: 2, comm: 'chrome', rssKB: 1, cwd: '/home/u' });
  const procs = readProcesses(root, { wantCwd: (n) => n === 'node' });
  expect(procs.find((p) => p.pid === 1)!.cwd).toBe('/home/u/p');
  expect(procs.find((p) => p.pid === 2)!).toMatchObject({ cwd: null, cwdDeleted: false });
});

test('cmdlineCache : la 2e passe ne relit pas cmdline, et purge les absents', () => {
  const root = makeProcRoot();
  addProc(root, { pid: 20, comm: 'node', rssKB: 1, starttime: 5, cmdline: ['node', 'a'] });
  addProc(root, { pid: 21, comm: 'node', rssKB: 1, starttime: 6, cmdline: ['node', 'b'] });
  const cache = new Map<string, string>();
  expect(readProcesses(root, { cmdlineCache: cache }).map((p) => p.cmdline)).toEqual(['node a', 'node b']);
  expect([...cache.keys()].sort()).toEqual(['20:5:node', '21:6:node']);
  rmSync(join(root, '20', 'cmdline'));
  expect(readProcesses(root, { cmdlineCache: cache }).find((p) => p.pid === 20)?.cmdline).toBe('node a');
  rmSync(join(root, '21'), { recursive: true });
  readProcesses(root, { cmdlineCache: cache });
  expect([...cache.keys()]).toEqual(['20:5:node']);
});

test('cmdlineCache : un exec (même PID et starttime, autre nom) force la relecture', () => {
  const root = makeProcRoot();
  addProc(root, { pid: 40, comm: 'zsh', rssKB: 1, starttime: 9, cmdline: ['zsh'] });
  const cache = new Map<string, string>();
  readProcesses(root, { cmdlineCache: cache });
  rmSync(join(root, '40'), { recursive: true });
  addProc(root, { pid: 40, comm: 'node', rssKB: 1, starttime: 9, cmdline: ['node', 'server.js'] });
  expect(readProcesses(root, { cmdlineCache: cache })[0]!.cmdline).toBe('node server.js');
  expect([...cache.keys()]).toEqual(['40:9:node']);
});

test('cwdCache : relu au plus toutes les maxAgeMs par processus, purge les absents', () => {
  const root = makeProcRoot();
  addProc(root, { pid: 30, comm: 'node', rssKB: 1, starttime: 7, cwd: '/home/u/a' });
  addProc(root, { pid: 31, comm: 'node', rssKB: 1, starttime: 8, cwd: '/home/u/old (deleted)' });
  const entries = new Map<string, CwdEntry>();
  const pass = (now: number) => readProcesses(root, { cwdCache: { entries, now, maxAgeMs: 30_000 } });
  expect(pass(0).map((p) => [p.cwd, p.cwdDeleted])).toEqual([['/home/u/a', false], ['/home/u/old', true]]);
  rmSync(join(root, '30', 'cwd'));
  symlinkSync('/home/u/b', join(root, '30', 'cwd'));
  expect(pass(29_000).find((p) => p.pid === 30)!.cwd).toBe('/home/u/a'); // encore en cache
  expect(pass(30_000).find((p) => p.pid === 30)!.cwd).toBe('/home/u/b'); // rafraîchi
  rmSync(join(root, '31'), { recursive: true });
  pass(31_000);
  expect([...entries.keys()]).toEqual(['30:7:node']);
});

test('statusCache : status relu seulement si le RSS de stat change, ou après maxAgeMs ; purge les absents', () => {
  const root = makeProcRoot();
  addProc(root, { pid: 50, comm: 'node', rssKB: 400, swapKB: 10, rssPages: 100, starttime: 3 });
  addProc(root, { pid: 51, comm: 'idle', rssKB: 40, rssPages: 10, starttime: 4 });
  const entries = new Map<string, StatusEntry>();
  const pass = (now: number) => readProcesses(root, { statusCache: { entries, now, maxAgeMs: 10_000 } });
  expect(pass(0).map((p) => [p.pid, p.rssKB, p.swapKB])).toEqual([[50, 400, 10], [51, 40, 0]]);
  // status modifié sans changement du RSS de stat : valeur en cache
  rmSync(join(root, '50'), { recursive: true });
  addProc(root, { pid: 50, comm: 'node', rssKB: 400, swapKB: 99, rssPages: 100, starttime: 3 });
  expect(pass(5_000).find((p) => p.pid === 50)!.swapKB).toBe(10);
  expect(pass(10_000).find((p) => p.pid === 50)!.swapKB).toBe(99); // trop ancien : relu
  // RSS de stat changé : relu tout de suite
  rmSync(join(root, '50'), { recursive: true });
  addProc(root, { pid: 50, comm: 'node', rssKB: 800, swapKB: 99, rssPages: 200, starttime: 3 });
  expect(pass(11_000).find((p) => p.pid === 50)!.rssKB).toBe(800);
  rmSync(join(root, '51'), { recursive: true });
  pass(12_000);
  expect([...entries.keys()]).toEqual(['50:3:node']);
});
