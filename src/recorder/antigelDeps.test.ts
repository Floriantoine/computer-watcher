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
