import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { addProc, makeProcRoot } from '../collector/fakeProc';
import { runScopeDeps } from './runScopesFs';

test('dossiers d’un cgroup (sous-dossiers seulement), cgroup.procs, dossier courant ; chemins refusés', () => {
  mkdirSync(join(homedir(), '.cache'), { recursive: true });
  const sys = mkdtempSync(join(homedir(), '.cache', 'pw-l4-sysfs-'));
  const slice = join(sys, 'u/cwatch.slice/cwatch-p.slice/cwatch-p-demo.slice');
  mkdirSync(join(slice, 'cwatch-p-demo-r0000000001.scope'), { recursive: true });
  writeFileSync(join(slice, 'memory.current'), '0\n');
  writeFileSync(join(slice, 'cwatch-p-demo-r0000000001.scope', 'cgroup.procs'), '800\n801\nx\n\n');
  const proc = makeProcRoot();
  addProc(proc, { pid: 800, comm: 'tail', cwd: '/home/u/demo' });
  addProc(proc, { pid: 801, comm: 'tail', cwd: null });
  const d = runScopeDeps(proc, sys);
  expect(d.listDir('/u/cwatch.slice/cwatch-p.slice/cwatch-p-demo.slice')).toEqual(['cwatch-p-demo-r0000000001.scope']);
  expect(d.listDir('/u/absent')).toBeNull();
  expect(d.listDir('/u/../..')).toBeNull();
  expect(d.listDir('u')).toBeNull();
  expect(d.procsOf('/u/cwatch.slice/cwatch-p.slice/cwatch-p-demo.slice/cwatch-p-demo-r0000000001.scope')).toEqual([800, 801]);
  expect(d.procsOf('/u/absent')).toBeNull();
  expect(d.cwdOf(800)).toBe('/home/u/demo');
  expect(d.cwdOf(801)).toBeNull();
  expect(d.cwdOf(-1)).toBeNull();
});
