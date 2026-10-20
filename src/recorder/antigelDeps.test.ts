// Vraies dépendances de l'anti-gel du service : construites seulement, jamais appelées sur le vrai système (aucun busctl).
import { expect, test, vi } from 'vitest';
import { addProc, makeProcRoot } from '../core/collector/fakeProc';
import { antigelDepsFor } from './antigelDeps';

test('PROC_WATCH_NO_ANTIGEL=1 : aucune dépendance (anti-gel inactif, aucun busctl, aucune lecture)', () => {
  const exists = vi.fn(() => true);
  expect(antigelDepsFor({ env: { PROC_WATCH_NO_ANTIGEL: '1' }, uid: 1000, selfPid: 1, exists })).toBeUndefined();
  expect(exists).not.toHaveBeenCalled();
});

test('busctl absent : indisponible, et tout appel échoue sans rien lancer', async () => {
  const proc = makeProcRoot();
  addProc(proc, { pid: 900, comm: 'node', cgroup: '/user.slice/user-1000.slice/user@1000.service/app.slice/r.service' });
  const d = antigelDepsFor({ env: {}, uid: 1000, selfPid: 900, exists: () => false, procRoot: proc, sysfsRoot: '/nonexistent' })!;
  expect(d.probe()).toMatchObject({ ok: false });
  await expect(d.client.startScope('cwatch-p-alpha-1.scope', 'cwatch-p-alpha.slice', [700])).rejects.toMatchObject({ code: 'unreachable' });
  expect(d.cgroupOf(900)).toBe('/user.slice/user-1000.slice/user@1000.service/app.slice/r.service');
  expect(d.stats('/user.slice')).toBeNull();
});

test('busctl présent : dépendances construites (chemin de systemBin), aucun appel lancé à la construction', () => {
  const proc = makeProcRoot();
  const exists = vi.fn((p: string) => p === '/usr/bin/busctl');
  const d = antigelDepsFor({ env: {}, uid: 1000, selfPid: 900, exists, procRoot: proc, sysfsRoot: '/nonexistent' })!;
  expect(d).toBeDefined();
  expect(exists).toHaveBeenCalledWith('/usr/bin/busctl');
  expect(d.client.calls()).toBe(0);
  // sonde sur un faux /proc et un faux sysfs : lecture seule, aucun busctl
  expect(d.probe()).toMatchObject({ ok: false });
  expect(d.client.calls()).toBe(0);
});

test('bureau prioritaire : lecture sysfs bornée à une liste de fichiers, chemins « .. » refusés ; origines 0600 relues filtrées', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, statSync, symlinkSync, rmSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const { readDeskFile, loadDeskOriginals, saveDeskOriginals, antigelDeskPath } = await import('./antigelDeps');
  mkdirSync(join(homedir(), '.cache'), { recursive: true });
  const root = mkdtempSync(join(homedir(), '.cache', 'pw-desk-'));
  try {
    mkdirSync(join(root, 'sys', 'a.slice'), { recursive: true });
    writeFileSync(join(root, 'sys', 'a.slice', 'cpu.weight'), '100\n');
    writeFileSync(join(root, 'sys', 'a.slice', 'memory.max'), '1\n');
    expect(readDeskFile(join(root, 'sys'), '/a.slice', 'cpu.weight')).toBe('100\n');
    expect(readDeskFile(join(root, 'sys'), '/a.slice', 'memory.max' as never)).toBeNull();
    expect(readDeskFile(join(root, 'sys'), '/a.slice/../a.slice', 'cpu.weight')).toBeNull();
    expect(readDeskFile(join(root, 'sys'), 'a.slice', 'cpu.weight')).toBeNull();
    expect(readDeskFile(join(root, 'sys'), '/absent.slice', 'cpu.weight')).toBeNull();

    const data = join(root, 'data');
    mkdirSync(data);
    expect(loadDeskOriginals(data)).toEqual({});
    const BASE = '/user.slice/user-1000.slice/user@1000.service';
    saveDeskOriginals(data, { 'session.slice': { cgroup: `${BASE}/session.slice`, cpuWeight: null } });
    expect(statSync(antigelDeskPath(data)).mode & 0o777).toBe(0o600);
    expect(loadDeskOriginals(data)).toEqual({ 'session.slice': { cgroup: `${BASE}/session.slice`, cpuWeight: null } });
    writeFileSync(antigelDeskPath(data), JSON.stringify({ version: 1, units: { 'cwatch-p-a.slice': { cgroup: '/x/cwatch-p-a.slice', cpuWeight: 1 } } }));
    expect(loadDeskOriginals(data)).toEqual({});
    writeFileSync(antigelDeskPath(data), '{');
    expect(loadDeskOriginals(data)).toEqual({});
    rmSync(antigelDeskPath(data));
    writeFileSync(join(data, 'cible.json'), JSON.stringify({ version: 1, units: { 'session.slice': { cgroup: `${BASE}/session.slice`, cpuWeight: 5 } } }));
    symlinkSync(join(data, 'cible.json'), antigelDeskPath(data));
    expect(loadDeskOriginals(data)).toEqual({}); // lien symbolique jamais suivi
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
