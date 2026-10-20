import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { fridgeDepsFor, reclaimPath, underCwatch } from './fridgeDeps';

const UB = '/user.slice/user-1000.slice/user@1000.service';
const PS = `${UB}/cwatch.slice/cwatch-p.slice/cwatch-p-alpha.slice`;
let sys: string;
beforeEach(() => {
  mkdirSync(join(homedir(), '.cache'), { recursive: true });
  sys = mkdtempSync(join(homedir(), '.cache', 'pw-fridge-sys-'));
});
afterEach(() => rmSync(sys, { recursive: true, force: true }));

test('chemins : seulement sous cwatch.slice de cet utilisateur ; reclaim seulement sur une slice de projet à son chemin exact', () => {
  expect(underCwatch(`${UB}/cwatch.slice`, 1000)).not.toBeNull();
  expect(underCwatch(PS, 1000)).toBe(PS);
  for (const c of [`${UB}/app.slice`, `${UB}/session.slice`, `${UB}/cwatch.slice/../app.slice`, '/user.slice/user-1001.slice/user@1001.service/cwatch.slice', `${UB}/cwatch.slicex`, 'cwatch.slice']) {
    expect(underCwatch(c, 1000), c).toBeNull();
  }
  expect(reclaimPath(PS, 1000)).toBe(PS);
  expect(reclaimPath(`${UB}/cwatch.slice/cwatch-e2eab12.slice/cwatch-e2eab12-a.slice`, 1000)).not.toBeNull();
  for (const c of [`${UB}/cwatch.slice`, `${PS}/cwatch-p-alpha-a1.scope`, `${UB}/cwatch.slice/cwatch-p-alpha.slice`, `${UB}/cwatch.slice/cwatch-p.slice/cwatch-p-autres.slice/x`, `${UB}/app.slice/cwatch-p-alpha.slice`]) {
    expect(reclaimPath(c, 1000), c).toBeNull();
  }
});

test('lectures : liste fermée de fichiers, pas de lien suivi ; reclaim écrit la taille demandée', async () => {
  const d = fridgeDepsFor({ env: {}, uid: 1000, selfPid: 1, sysfsRoot: sys, exists: () => true })!;
  const dir = join(sys, PS);
  mkdirSync(join(dir, 'cwatch-p-alpha-a1.scope'), { recursive: true });
  writeFileSync(join(dir, 'cgroup.freeze'), '1\n');
  writeFileSync(join(dir, 'memory.high'), 'max\n');
  writeFileSync(join(dir, 'memory.reclaim'), '');
  writeFileSync(join(sys, 'secret'), 'x');
  symlinkSync(join(sys, 'secret'), join(dir, 'memory.current'));
  expect(d.read(PS, 'cgroup.freeze')).toBe('1\n');
  expect(d.read(PS, 'memory.high')).toBeNull(); // hors liste
  expect(d.read(PS, 'memory.current')).toBeNull(); // lien symbolique
  expect(d.read(`${UB}/app.slice`, 'cgroup.freeze')).toBeNull();
  expect(d.list(PS)).toEqual(['cwatch-p-alpha-a1.scope']);
  expect(d.list(`${UB}/app.slice`)).toBeNull();
  await expect(d.reclaim(PS, 64 * 1024 * 1024)).resolves.toBe('ok');
  expect(readFileSync(join(dir, 'memory.reclaim'), 'utf8')).toBe(String(64 * 1024 * 1024));
  await expect(d.reclaim(`${UB}/cwatch.slice`, 1)).rejects.toThrow(/refusé/);
  await expect(d.reclaim(PS, 0)).rejects.toThrow(/refusée/);
});

test('PROC_WATCH_NO_ANTIGEL=1 : rien', () => {
  expect(fridgeDepsFor({ env: { PROC_WATCH_NO_ANTIGEL: '1' }, uid: 1000, selfPid: 1 })).toBeUndefined();
});
