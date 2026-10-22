import { describe, expect, test } from 'vitest';
import { GiB, INFINITY_T, MiB, projectCaps } from './limits';
import {
  BusctlError, DESCRIPTION, classifyBusctlError, createBusctl, createSystemdClient, setProjectCapsArgv, setSliceArgv,
  startProjectSliceArgv, startScopeArgv, startSliceArgv, stopTestUnitArgv, type ExecLike,
} from './systemd';

const HEAD = ['--user', '--timeout=5', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager'];
const L = { reserveBytes: 4 * GiB, highBytes: 12 * GiB, maxBytes: 14 * GiB, swapMaxBytes: 4 * GiB };
const REAL_EXISTS = 'Call failed: Unit cwatch-p-alpha.slice was already loaded or has a fragment file.';
const C4 = projectCaps(4096); // freine à 4 Go, swap 1 Go, arrêt 10 % au-dessus
const C6 = projectCaps(6144);

describe('argv busctl figés', () => {
  test('scope neuf : PIDs dédoublonnés, Slice de projet, OOMPolicy=continue, CollectMode=inactive-or-failed, Description, aucune limite', () => {
    expect(startScopeArgv('cwatch-p-alpha-a1.scope', 'cwatch-p-alpha.slice', [700, 701, 700])).toEqual([
      ...HEAD, 'StartTransientUnit', 'ssa(sv)a(sa(sv))', 'cwatch-p-alpha-a1.scope', 'fail', '5',
      'PIDs', 'au', '2', '700', '701', 'Slice', 's', 'cwatch-p-alpha.slice', 'OOMPolicy', 's', 'continue', 'CollectMode', 's', 'inactive-or-failed',
      'Description', 's', DESCRIPTION, '0',
    ]);
    expect(startScopeArgv('cwatch-p-alpha-a1.scope', 'cwatch-p-alpha.slice', [700]).join(' ')).not.toMatch(/Memory/);
    expect(startScopeArgv('cwatch-e2eab12-1.scope', 'cwatch-e2eab12-a.slice', [700])).toContain('cwatch-e2eab12-a.slice');
  });

  test('slice racine : plafonds, remise à infinity', () => {
    expect(startSliceArgv('cwatch.slice', L)).toEqual([
      ...HEAD, 'StartTransientUnit', 'ssa(sv)a(sa(sv))', 'cwatch.slice', 'fail', '4', 'Description', 's', DESCRIPTION,
      'MemoryHigh', 't', String(12 * GiB), 'MemoryMax', 't', String(14 * GiB), 'MemorySwapMax', 't', String(4 * GiB), '0',
    ]);
    expect(setSliceArgv('cwatch.slice', L)).toEqual([
      ...HEAD, 'SetUnitProperties', 'sba(sv)', 'cwatch.slice', 'true', '3',
      'MemoryHigh', 't', String(12 * GiB), 'MemoryMax', 't', String(14 * GiB), 'MemorySwapMax', 't', String(4 * GiB),
    ]);
    expect(setSliceArgv('cwatch-e2eab12.slice', null).slice(-9)).toEqual(['MemoryHigh', 't', INFINITY_T, 'MemoryMax', 't', INFINITY_T, 'MemorySwapMax', 't', INFINITY_T]);
    expect(setSliceArgv('cwatch.slice', { ...L, swapMaxBytes: 0 }).slice(-1)).toEqual(['0']);
  });

  test('slice de projet : budget (MemoryHigh), plafond dur (MemoryMax), part de swap (MemorySwapMax) ; sans budget : infinity', () => {
    expect(startProjectSliceArgv('cwatch-p-alpha.slice', C4)).toEqual([
      ...HEAD, 'StartTransientUnit', 'ssa(sv)a(sa(sv))', 'cwatch-p-alpha.slice', 'fail', '4', 'Description', 's', DESCRIPTION,
      'MemoryHigh', 't', String(4 * GiB), 'MemoryMax', 't', String(C4.maxBytes), 'MemorySwapMax', 't', String(GiB), '0',
    ]);
    expect(startProjectSliceArgv('cwatch-p-alpha.slice', null).slice(-10)).toEqual(['MemoryHigh', 't', INFINITY_T, 'MemoryMax', 't', INFINITY_T, 'MemorySwapMax', 't', INFINITY_T, '0']);
    expect(setProjectCapsArgv('cwatch-p-alpha.slice', C6)).toEqual([
      ...HEAD, 'SetUnitProperties', 'sba(sv)', 'cwatch-p-alpha.slice', 'true', '3',
      'MemoryHigh', 't', String(6 * GiB), 'MemoryMax', 't', String(C6.maxBytes), 'MemorySwapMax', 't', String(1.5 * GiB),
    ]);
    expect(setProjectCapsArgv('cwatch-e2eab12-a.slice', null).slice(-9)).toEqual(['MemoryHigh', 't', INFINITY_T, 'MemoryMax', 't', INFINITY_T, 'MemorySwapMax', 't', INFINITY_T]);
    // plafond dur provisoire (convergence) et part de swap nulle : acceptés
    expect(setProjectCapsArgv('cwatch-p-alpha.slice', { ...C4, maxBytes: 9 * GiB, swapMaxBytes: 0 }).slice(-6)).toEqual(['MemoryMax', 't', String(9 * GiB), 'MemorySwapMax', 't', '0']);
  });

  test('refus : noms d’unités, PIDs, tailles', () => {
    for (const u of ['../x.scope', 'cwatch-p-A-1.scope', 'app-dev.warp.Warp@1.service', 'cwatch.slice', 'cwatch-p-alpha.scope']) {
      expect(() => startScopeArgv(u, 'cwatch-p-alpha.slice', [700]), u).toThrow();
    }
    expect(() => startScopeArgv('cwatch-p-beta-a1.scope', 'cwatch-p-alpha.slice', [700])).toThrow();
    for (const s of ['app.slice', 'user.slice', 'cwatch.slice', 'cwatch-p-alpha-a1.scope', 'cwatch-p-alpha-xyz.slice']) {
      expect(() => startScopeArgv('cwatch-p-alpha-a1.scope', s, [700]), s).toThrow();
      expect(() => setProjectCapsArgv(s, null), s).toThrow();
      expect(() => startProjectSliceArgv(s, C4), s).toThrow();
    }
    // plafonds de la slice racine (réserve, plafond dynamique) : jamais sur une slice de projet, qui a les siens
    for (const s of ['app.slice', 'user.slice', 'cwatch-p-alpha.slice', 'cwatch-e2eab12-a.slice', 'cwatch-p-alpha-a1.scope']) {
      expect(() => setSliceArgv(s, null), s).toThrow();
      expect(() => startSliceArgv(s, L), s).toThrow();
    }
    for (const pids of [[], [1], [0], [-5], [1.5], [4_194_305], Array.from({ length: 257 }, (_, i) => i + 2)]) {
      expect(() => startScopeArgv('cwatch-p-alpha-a1.scope', 'cwatch-p-alpha.slice', pids), JSON.stringify(pids).slice(0, 30)).toThrow();
    }
    for (const b of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => setProjectCapsArgv('cwatch-p-alpha.slice', { ...C4, highBytes: b }), `high ${b}`).toThrow();
      expect(() => setProjectCapsArgv('cwatch-p-alpha.slice', { ...C4, maxBytes: b }), `max ${b}`).toThrow();
    }
    for (const b of [-1, 1.5, Number.NaN]) expect(() => setProjectCapsArgv('cwatch-p-alpha.slice', { ...C4, swapMaxBytes: b }), `swap ${b}`).toThrow();
    // plafond dur sous le budget : refusé (le noyau tuerait avant de freiner)
    expect(() => setProjectCapsArgv('cwatch-p-alpha.slice', { ...C4, maxBytes: C4.highBytes - 4096 })).toThrow();
    expect(() => startProjectSliceArgv('cwatch-p-alpha.slice', { ...C4, maxBytes: C4.highBytes - 4096 })).toThrow();
    expect(() => setSliceArgv('cwatch.slice', { ...L, swapMaxBytes: -1 })).toThrow();
  });

  test('StopUnit : seulement les trois motifs de test cwatch-e2e…', () => {
    for (const u of ['cwatch-e2eab12.slice', 'cwatch-e2eab12-a.slice', 'cwatch-e2eab12-1.scope']) {
      expect(stopTestUnitArgv(u)).toEqual([...HEAD, 'StopUnit', 'ss', u, 'replace']);
    }
    for (const u of ['cwatch.slice', 'cwatch-p-alpha.slice', 'cwatch-p-alpha-a1.scope', 'cwatch-p-e2etest.slice', 'cwatch-p-e2etest-1.scope', 'app.slice']) {
      expect(() => stopTestUnitArgv(u), u).toThrow();
    }
  });
});

describe('exécution et erreurs', () => {
  test('classement des erreurs de busctl', () => {
    expect(classifyBusctlError(REAL_EXISTS)).toBe('exists');
    expect(classifyBusctlError('Call failed: Unit cwatch.slice was already loaded or has a fragment file.')).toBe('exists');
    expect(classifyBusctlError('org.freedesktop.systemd1.UnitExists')).toBe('exists');
    expect(classifyBusctlError('Call failed: Unit cwatch-p-a.scope not loaded.')).toBe('no-unit');
    expect(classifyBusctlError('Call failed: Unit cwatch-p-a.scope not found.')).toBe('no-unit');
    expect(classifyBusctlError('Call failed: Unit cwatch-p-a.scope is not active.')).toBe('no-unit');
    expect(classifyBusctlError('Call failed: Access denied')).toBe('denied');
    expect(classifyBusctlError('Failed to connect to bus: No such file or directory')).toBe('unreachable');
    expect(classifyBusctlError('No such file or directory')).toBe('other');
    expect(classifyBusctlError('Call failed: Connection timed out')).toBe('timeout');
    expect(classifyBusctlError('', true)).toBe('timeout');
    expect(classifyBusctlError('Call failed: Invalid argument')).toBe('other');
  });

  test('createBusctl : chemin figé, tableau d’arguments, environnement nettoyé, délai, sans shell', async () => {
    const seen: { file: string; args: string[]; env: NodeJS.ProcessEnv; timeout: number }[] = [];
    const ok: ExecLike = (file, args, opts, cb) => { seen.push({ file, args, env: opts.env, timeout: opts.timeout }); cb(null, '', ''); return null; };
    const run = createBusctl('/usr/bin/busctl', { PATH: '/tmp/.mount_x/usr/bin:/usr/bin', APPDIR: '/tmp/.mount_x', HOME: '/h' }, ok);
    await run(['--user', '--timeout=5', 'x']);
    expect(seen).toEqual([{ file: '/usr/bin/busctl', args: ['--user', '--timeout=5', 'x'], env: { PATH: '/usr/bin', HOME: '/h' }, timeout: 7000 }]);
    expect(() => createBusctl('/bin/busctl', {}, ok)).not.toThrow();
    for (const bin of ['busctl', '/tmp/busctl', '/usr/local/bin/busctl', '/usr/bin/busctl ']) expect(() => createBusctl(bin, {}, ok), bin).toThrow();
    expect(() => createBusctl('busctl')).toThrow();
    const fail: ExecLike = (_f, _a, _o, cb) => { cb(Object.assign(new Error('x'), { killed: false }), '', 'Call failed: Access denied\n'); return null; };
    await expect(createBusctl('/usr/bin/busctl', {}, fail)(['--user', '--timeout=5'])).rejects.toMatchObject({ code: 'denied', message: 'Call failed: Access denied' });
  });

  test('createBusctl : argv refusé sans exécution ; busctl absent → unreachable ; délai dépassé → timeout', async () => {
    let n = 0;
    const count: ExecLike = (_f, _a, _o, cb) => { n++; cb(null, '', ''); return null; };
    const run = createBusctl('/usr/bin/busctl', {}, count);
    for (const argv of [[], ['call'], ['--system', '--timeout=5'], ['--user'], ['--user', '--timeout=60']]) await expect(run(argv), argv.join(' ')).rejects.toThrow();
    expect(n).toBe(0);
    const absent: ExecLike = (_f, _a, _o, cb) => { cb(Object.assign(new Error('spawn /usr/bin/busctl ENOENT'), { code: 'ENOENT' }), '', ''); return null; };
    await expect(createBusctl('/usr/bin/busctl', {}, absent)(['--user', '--timeout=5'])).rejects.toMatchObject({ code: 'unreachable' });
    const slow: ExecLike = (_f, _a, _o, cb) => { cb(Object.assign(new Error('killed'), { killed: true }), '', ''); return null; };
    await expect(createBusctl('/usr/bin/busctl', {}, slow)(['--user', '--timeout=5'])).rejects.toMatchObject({ code: 'timeout' });
  });

  test('client : ensureSlice et ensureProjectSlice retombent sur SetUnitProperties si l’unité est déjà chargée ; compteur ; nom refusé sans appel', async () => {
    const argvs: string[][] = [];
    const client = createSystemdClient(async (argv) => {
      argvs.push([...argv]);
      if (argv.includes('StartTransientUnit')) throw new BusctlError(REAL_EXISTS, classifyBusctlError(REAL_EXISTS));
    });
    await client.ensureSlice('cwatch.slice', L);
    expect(argvs.map((a) => a[6])).toEqual(['StartTransientUnit', 'SetUnitProperties']);
    expect(client.calls()).toBe(2);
    await client.ensureProjectSlice('cwatch-p-alpha.slice', C4);
    expect(argvs.slice(2).map((a) => a[6])).toEqual(['StartTransientUnit', 'SetUnitProperties']);
    expect(argvs[3]!.slice(-9)).toEqual(['MemoryHigh', 't', String(4 * GiB), 'MemoryMax', 't', String(C4.maxBytes), 'MemorySwapMax', 't', String(GiB)]);
    expect(client.calls()).toBe(4);
    await expect(client.startScope('../x.scope', 'cwatch-p-alpha.slice', [700])).rejects.toThrow();
    await expect(client.ensureProjectSlice('cwatch.slice', null)).rejects.toThrow();
    expect(client.calls()).toBe(4);
    expect(MiB).toBe(1024 * 1024);
  });

  test('client : une autre erreur est propagée sans second appel ; startScope et setProjectCaps passent par le lanceur', async () => {
    const argvs: string[][] = [];
    const client = createSystemdClient(async (argv) => {
      argvs.push([...argv]);
      if (argv[6] === 'StartTransientUnit' && argv[8] === 'cwatch-p-alpha.slice') throw new BusctlError('Call failed: Access denied', 'denied');
    });
    await expect(client.ensureProjectSlice('cwatch-p-alpha.slice', null)).rejects.toMatchObject({ code: 'denied' });
    expect(argvs).toHaveLength(1);
    await client.startScope('cwatch-p-alpha-a1.scope', 'cwatch-p-alpha.slice', [700]);
    await client.setProjectCaps('cwatch-p-alpha.slice', null);
    expect(argvs.at(-1)!.slice(6, 9)).toEqual(['SetUnitProperties', 'sba(sv)', 'cwatch-p-alpha.slice']);
    await client.stopTestUnit('cwatch-e2eab12-1.scope');
    expect(client.calls()).toBe(4);
  });
});
