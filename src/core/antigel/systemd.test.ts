import { describe, expect, test } from 'vitest';
import { GiB, INFINITY_T, MiB } from './limits';
import {
  BusctlError, DESCRIPTION, classifyBusctlError, createBusctl, createSystemdClient, setProjectHighArgv, setSliceArgv,
  startProjectSliceArgv, startScopeArgv, startSliceArgv, stopTestUnitArgv, type ExecLike,
} from './systemd';

const HEAD = ['--user', '--timeout=5', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager'];
const L = { reserveBytes: 4 * GiB, highBytes: 12 * GiB, maxBytes: 14 * GiB, swapMaxBytes: 4 * GiB };
const REAL_EXISTS = 'Call failed: Unit cwatch-p-alpha.slice was already loaded or has a fragment file.';

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

  test('slice de projet : seulement MemoryHigh (budget ou infinity)', () => {
    expect(startProjectSliceArgv('cwatch-p-alpha.slice', 4 * GiB)).toEqual([
      ...HEAD, 'StartTransientUnit', 'ssa(sv)a(sa(sv))', 'cwatch-p-alpha.slice', 'fail', '2', 'Description', 's', DESCRIPTION, 'MemoryHigh', 't', String(4 * GiB), '0',
    ]);
    expect(startProjectSliceArgv('cwatch-p-alpha.slice', null).slice(-2)).toEqual([INFINITY_T, '0']);
    expect(setProjectHighArgv('cwatch-p-alpha.slice', 6 * GiB)).toEqual([...HEAD, 'SetUnitProperties', 'sba(sv)', 'cwatch-p-alpha.slice', 'true', '1', 'MemoryHigh', 't', String(6 * GiB)]);
    expect(setProjectHighArgv('cwatch-e2eab12-a.slice', null).slice(-1)).toEqual([INFINITY_T]);
    expect(setProjectHighArgv('cwatch-p-alpha.slice', null).join(' ')).not.toMatch(/MemoryMax|MemorySwapMax/);
  });

  test('refus : noms d’unités, PIDs, tailles', () => {
    for (const u of ['../x.scope', 'cwatch-p-A-1.scope', 'app-dev.warp.Warp@1.service', 'cwatch.slice', 'cwatch-p-alpha.scope']) {
      expect(() => startScopeArgv(u, 'cwatch-p-alpha.slice', [700]), u).toThrow();
    }
    expect(() => startScopeArgv('cwatch-p-beta-a1.scope', 'cwatch-p-alpha.slice', [700])).toThrow();
    for (const s of ['app.slice', 'user.slice', 'cwatch.slice', 'cwatch-p-alpha-a1.scope', 'cwatch-p-alpha-xyz.slice']) {
      expect(() => startScopeArgv('cwatch-p-alpha-a1.scope', s, [700]), s).toThrow();
      expect(() => setProjectHighArgv(s, null), s).toThrow();
    }
    // MemoryMax / MemorySwapMax : seulement sur une slice racine, jamais sur une slice de projet
    for (const s of ['app.slice', 'user.slice', 'cwatch-p-alpha.slice', 'cwatch-e2eab12-a.slice', 'cwatch-p-alpha-a1.scope']) {
      expect(() => setSliceArgv(s, null), s).toThrow();
      expect(() => startSliceArgv(s, L), s).toThrow();
    }
    for (const pids of [[], [1], [0], [-5], [1.5], [4_194_305], Array.from({ length: 257 }, (_, i) => i + 2)]) {
      expect(() => startScopeArgv('cwatch-p-alpha-a1.scope', 'cwatch-p-alpha.slice', pids), JSON.stringify(pids).slice(0, 30)).toThrow();
    }
    for (const b of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) expect(() => setProjectHighArgv('cwatch-p-alpha.slice', b)).toThrow();
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
    await client.ensureProjectSlice('cwatch-p-alpha.slice', 4 * GiB);
    expect(argvs.slice(2).map((a) => a[6])).toEqual(['StartTransientUnit', 'SetUnitProperties']);
    expect(argvs[3]!.slice(-3)).toEqual(['MemoryHigh', 't', String(4 * GiB)]);
    expect(client.calls()).toBe(4);
    await expect(client.startScope('../x.scope', 'cwatch-p-alpha.slice', [700])).rejects.toThrow();
    await expect(client.ensureProjectSlice('cwatch.slice', null)).rejects.toThrow();
    expect(client.calls()).toBe(4);
    expect(MiB).toBe(1024 * 1024);
  });

  test('client : une autre erreur est propagée sans second appel ; startScope et setProjectHigh passent par le lanceur', async () => {
    const argvs: string[][] = [];
    const client = createSystemdClient(async (argv) => {
      argvs.push([...argv]);
      if (argv[6] === 'StartTransientUnit' && argv[8] === 'cwatch-p-alpha.slice') throw new BusctlError('Call failed: Access denied', 'denied');
    });
    await expect(client.ensureProjectSlice('cwatch-p-alpha.slice', null)).rejects.toMatchObject({ code: 'denied' });
    expect(argvs).toHaveLength(1);
    await client.startScope('cwatch-p-alpha-a1.scope', 'cwatch-p-alpha.slice', [700]);
    await client.setProjectHigh('cwatch-p-alpha.slice', null);
    await client.stopTestUnit('cwatch-e2eab12-1.scope');
    expect(client.calls()).toBe(4);
  });
});
