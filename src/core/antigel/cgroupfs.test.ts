import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { addProc, makeProcRoot } from '../collector/fakeProc';
import { availability, parseCgroupFile, parseLimit, parseMemoryEvents, probeAvailability, readCgroup, readCgroupStats, reverify, stillSame, userBaseOf } from './cgroupfs';

const BASE = '/user.slice/user-1000.slice/user@1000.service';
const WARP = `${BASE}/app.slice/app-dev.warp.Warp@1.service`;

describe('cgroups', () => {
  test('parseCgroupFile : seulement la ligne v2 « 0:: », chemin absolu', () => {
    expect(parseCgroupFile(`0::${WARP}\n`)).toBe(WARP);
    expect(parseCgroupFile('12:memory:/x\n0::/a\n')).toBe('/a');
    expect(parseCgroupFile('12:memory:/x\n')).toBeNull();
    expect(parseCgroupFile('0::relatif\n')).toBeNull();
  });
  test('userBaseOf', () => {
    expect(userBaseOf(WARP, 1000)).toBe(BASE);
    expect(userBaseOf(BASE, 1000)).toBe(BASE);
    expect(userBaseOf('/system.slice/x.service', 1000)).toBeNull();
    expect(userBaseOf(`${BASE}x/app.slice`, 1000)).toBeNull();
    expect(userBaseOf(WARP, 1001)).toBeNull();
    expect(userBaseOf(null, 1000)).toBeNull();
  });
  test('disponibilité : chaque raison, dans l’ordre', () => {
    const ok = { cgroup2: true, selfCgroup: `${BASE}/app.slice/computer-watcher-recorder.service`, uid: 1000, subtreeControl: 'cpu memory pids\n', busctl: '/usr/bin/busctl' };
    expect(availability(ok)).toEqual({ ok: true, userBase: BASE, busctl: '/usr/bin/busctl' });
    expect(availability({ ...ok, cgroup2: false })).toEqual({ ok: false, reason: 'cgroups v2 absents (hiérarchie unifiée non montée)' });
    expect(availability({ ...ok, selfCgroup: '/system.slice/x.service' })).toEqual({ ok: false, reason: 'le service ne tourne pas sous le gestionnaire systemd de l’utilisateur' });
    expect(availability({ ...ok, subtreeControl: 'cpu pids' })).toEqual({ ok: false, reason: 'contrôleur mémoire non délégué à la session (memory absent de cgroup.subtree_control)' });
    expect(availability({ ...ok, subtreeControl: null }).ok).toBe(false);
    expect(availability({ ...ok, busctl: null })).toEqual({ ok: false, reason: 'busctl introuvable (/usr/bin/busctl)' });
  });
  test('probeAvailability : faux /proc et faux sysfs', () => {
    const proc = makeProcRoot();
    addProc(proc, { pid: 900, comm: 'node', cgroup: `${BASE}/app.slice/rec.service` });
    const sys = mkdtempSync(join(tmpdir(), 'pw-sysfs-'));
    expect(probeAvailability({ procRoot: proc, sysfsRoot: sys, uid: 1000, selfPid: 900, busctl: '/usr/bin/busctl' })).toMatchObject({ ok: false, reason: expect.stringMatching(/cgroups v2/) });
    writeFileSync(join(sys, 'cgroup.controllers'), 'cpu memory pids\n');
    mkdirSync(join(sys, BASE), { recursive: true });
    writeFileSync(join(sys, BASE, 'cgroup.subtree_control'), 'cpu memory pids\n');
    expect(probeAvailability({ procRoot: proc, sysfsRoot: sys, uid: 1000, selfPid: 900, busctl: '/usr/bin/busctl' })).toEqual({ ok: true, userBase: BASE, busctl: '/usr/bin/busctl' });
  });
  test('memory.events, limites', () => {
    expect(parseMemoryEvents('low 0\nhigh 12\nmax 3\noom 1\noom_kill 2\noom_group_kill 0\n')).toEqual({ high: 12, max: 3, oom: 1, oomKill: 2 });
    expect(parseMemoryEvents('')).toEqual({ high: 0, max: 0, oom: 0, oomKill: 0 });
    expect(parseLimit('max\n')).toBeNull();
    expect(parseLimit('4294967296\n')).toBe(4294967296);
    expect(parseLimit('abc')).toBeNull();
  });
  test('readCgroupStats : faux sysfs ; chemin avec « .. » refusé ; absent → null', () => {
    const sys = mkdtempSync(join(tmpdir(), 'pw-sysfs-'));
    const dir = join(sys, BASE, 'cwatch.slice');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'memory.current'), '1073741824\n');
    writeFileSync(join(dir, 'memory.high'), '12884901888\n');
    writeFileSync(join(dir, 'memory.max'), 'max\n');
    writeFileSync(join(dir, 'memory.swap.max'), '0\n');
    writeFileSync(join(dir, 'memory.events'), 'high 4\noom_kill 1\n');
    writeFileSync(join(dir, 'cgroup.procs'), '10\n11\n');
    expect(readCgroupStats(sys, `${BASE}/cwatch.slice`)).toEqual({
      currentBytes: 1073741824, highBytes: 12884901888, maxBytes: null, swapMaxBytes: 0, events: { high: 4, max: 0, oom: 0, oomKill: 1 }, procs: 2,
    });
    expect(readCgroupStats(sys, `${BASE}/cwatch.slice/../cwatch.slice`)).toBeNull();
    expect(readCgroupStats(sys, `${BASE}/absent.slice`)).toBeNull();
  });
  test('revérification : même uid, même starttime (PID recyclé écarté), toujours dans le cgroup attendu, vivant', () => {
    const proc = makeProcRoot();
    addProc(proc, { pid: 10, comm: 'MainThread', starttime: 500, cgroup: WARP });
    addProc(proc, { pid: 11, comm: 'MainThread', starttime: 600, uid: 0, cgroup: WARP });
    addProc(proc, { pid: 12, comm: 'MainThread', starttime: 700, cgroup: `${BASE}/app.slice/run-u1.scope` });
    expect(readCgroup(proc, 10)).toBe(WARP);
    expect(stillSame(proc, 1000, { pid: 10, startTicks: 500 }, WARP)).toBe(true);
    expect(stillSame(proc, 1000, { pid: 10, startTicks: 499 }, WARP)).toBe(false); // PID recyclé
    expect(stillSame(proc, 1000, { pid: 11, startTicks: 600 }, WARP)).toBe(false); // autre uid
    expect(stillSame(proc, 1000, { pid: 12, startTicks: 700 }, WARP)).toBe(false); // déplacé entre-temps
    expect(stillSame(proc, 1000, { pid: 13, startTicks: 1 }, WARP)).toBe(false);   // mort
    expect(reverify(proc, 1000, [{ pid: 10, startTicks: 500 }, { pid: 10, startTicks: 1 }, { pid: 12, startTicks: 700 }], WARP)).toEqual([{ pid: 10, startTicks: 500 }]);
  });
  test('revérification : un zombie (état Z ou X) est écarté', () => {
    const proc = makeProcRoot();
    addProc(proc, { pid: 20, comm: 'MainThread', starttime: 800, cgroup: WARP });
    addProc(proc, { pid: 21, comm: 'MainThread', starttime: 810, cgroup: WARP, state: 'Z' });
    addProc(proc, { pid: 22, comm: 'MainThread', starttime: 820, cgroup: WARP, state: 'X' });
    expect(stillSame(proc, 1000, { pid: 20, startTicks: 800 }, WARP)).toBe(true);
    expect(stillSame(proc, 1000, { pid: 21, startTicks: 810 }, WARP)).toBe(false);
    expect(stillSame(proc, 1000, { pid: 22, startTicks: 820 }, WARP)).toBe(false);
    expect(reverify(proc, 1000, [{ pid: 20, startTicks: 800 }, { pid: 21, startTicks: 810 }, { pid: 22, startTicks: 820 }], WARP)).toEqual([{ pid: 20, startTicks: 800 }]);
  });
});
