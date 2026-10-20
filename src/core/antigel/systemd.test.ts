import { describe, expect, test } from 'vitest';
import { GiB, INFINITY_T, MiB } from './limits';
import {
  BusctlError, DESCRIPTION, attachArgv, classifyBusctlError, createBusctl, createSystemdClient, setScopeHighArgv, setSliceArgv,
  startScopeArgv, startSliceArgv, stopTestUnitArgv, type ExecLike,
} from './systemd';

const HEAD = ['--user', '--timeout=5', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager'];
const L = { reserveBytes: 4 * GiB, highBytes: 12 * GiB, maxBytes: 14 * GiB, swapMaxBytes: 4 * GiB };

describe('argv busctl figés', () => {
  test('StartTransientUnit d’un scope : PIDs, Slice, OOMPolicy=continue, Description, MemoryHigh facultatif', () => {
    expect(startScopeArgv('cwatch-p-alpha.scope', 'cwatch.slice', [700, 701], null)).toEqual([
      ...HEAD, 'StartTransientUnit', 'ssa(sv)a(sa(sv))', 'cwatch-p-alpha.scope', 'fail', '4',
      'PIDs', 'au', '2', '700', '701', 'Slice', 's', 'cwatch.slice', 'OOMPolicy', 's', 'continue', 'Description', 's', DESCRIPTION, '0',
    ]);
    const withBudget = startScopeArgv('cwatch-p-alpha.scope', 'cwatch.slice', [700], 4 * GiB);
    expect(withBudget[HEAD.length + 4]).toBe('5'); // 5 propriétés
    expect(withBudget.slice(-4)).toEqual(['MemoryHigh', 't', String(4 * GiB), '0']);
  });

  test('AttachProcessesToUnit, slice, budgets, remise à infinity', () => {
    expect(attachArgv('cwatch-p-alpha.scope', [702])).toEqual([...HEAD, 'AttachProcessesToUnit', 'ssau', 'cwatch-p-alpha.scope', '', '1', '702']);
    expect(startSliceArgv('cwatch.slice', L)).toEqual([
      ...HEAD, 'StartTransientUnit', 'ssa(sv)a(sa(sv))', 'cwatch.slice', 'fail', '4', 'Description', 's', DESCRIPTION,
      'MemoryHigh', 't', String(12 * GiB), 'MemoryMax', 't', String(14 * GiB), 'MemorySwapMax', 't', String(4 * GiB), '0',
    ]);
    expect(setSliceArgv('cwatch.slice', L)).toEqual([
      ...HEAD, 'SetUnitProperties', 'sba(sv)', 'cwatch.slice', 'true', '3',
      'MemoryHigh', 't', String(12 * GiB), 'MemoryMax', 't', String(14 * GiB), 'MemorySwapMax', 't', String(4 * GiB),
    ]);
    expect(setSliceArgv('cwatch.slice', null).slice(-9)).toEqual(['MemoryHigh', 't', INFINITY_T, 'MemoryMax', 't', INFINITY_T, 'MemorySwapMax', 't', INFINITY_T]);
    expect(setSliceArgv('cwatch.slice', { ...L, swapMaxBytes: 0 }).slice(-1)).toEqual(['0']);
    expect(setScopeHighArgv('cwatch-p-alpha.scope', 6 * GiB)).toEqual([...HEAD, 'SetUnitProperties', 'sba(sv)', 'cwatch-p-alpha.scope', 'true', '1', 'MemoryHigh', 't', String(6 * GiB)]);
    expect(setScopeHighArgv('cwatch-p-alpha.scope', null).slice(-1)).toEqual([INFINITY_T]);
  });

  test('refus : noms d’unités, PIDs, tailles', () => {
    for (const u of ['../x.scope', 'cwatch-p-A.scope', 'app-dev.warp.Warp@1.service', 'cwatch.slice']) {
      expect(() => startScopeArgv(u, 'cwatch.slice', [700], null), u).toThrow();
      expect(() => attachArgv(u, [700]), u).toThrow();
      expect(() => setScopeHighArgv(u, null), u).toThrow();
    }
    for (const s of ['app.slice', 'user.slice', 'cwatch-p-alpha.scope']) {
      expect(() => setSliceArgv(s, null), s).toThrow();
      expect(() => startScopeArgv('cwatch-p-alpha.scope', s, [700], null), s).toThrow();
    }
    for (const pids of [[], [1], [0], [-5], [1.5], [4_194_305], Array.from({ length: 257 }, (_, i) => i + 2)]) {
      expect(() => attachArgv('cwatch-p-alpha.scope', pids), JSON.stringify(pids).slice(0, 30)).toThrow();
    }
    for (const b of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) expect(() => setScopeHighArgv('cwatch-p-alpha.scope', b)).toThrow();
    expect(() => setSliceArgv('cwatch.slice', { ...L, swapMaxBytes: -1 })).toThrow();
  });

  test('StopUnit : seulement les unités de test cwatch-e2e…', () => {
    expect(stopTestUnitArgv('cwatch-e2eab12.slice')).toEqual([...HEAD, 'StopUnit', 'ss', 'cwatch-e2eab12.slice', 'replace']);
    expect(stopTestUnitArgv('cwatch-p-e2eab12.scope')).toEqual([...HEAD, 'StopUnit', 'ss', 'cwatch-p-e2eab12.scope', 'replace']);
    for (const u of ['cwatch.slice', 'cwatch-p-alpha.scope', 'app.slice', 'cwatch-p-e2eab12-ff00aa.scope']) expect(() => stopTestUnitArgv(u), u).toThrow();
  });
});

describe('exécution et erreurs', () => {
  test('classement des erreurs de busctl', () => {
    expect(classifyBusctlError('Call failed: Unit cwatch.slice already exists.')).toBe('exists');
    expect(classifyBusctlError('Call failed: Unit cwatch-p-a.scope not loaded.')).toBe('no-unit');
    expect(classifyBusctlError('Call failed: Unit cwatch-p-a.scope is not active.')).toBe('no-unit');
    expect(classifyBusctlError('Call failed: Access denied')).toBe('denied');
    expect(classifyBusctlError('Failed to connect to bus: No such file or directory')).toBe('unreachable');
    expect(classifyBusctlError('', true)).toBe('timeout');
    expect(classifyBusctlError('Call failed: Invalid argument')).toBe('other');
  });

  test('createBusctl : chemin absolu, tableau d’arguments, environnement nettoyé, délai, sans shell', async () => {
    const seen: { file: string; args: string[]; env: NodeJS.ProcessEnv; timeout: number }[] = [];
    const ok: ExecLike = (file, args, opts, cb) => { seen.push({ file, args, env: opts.env, timeout: opts.timeout }); cb(null, '', ''); return null; };
    const run = createBusctl('/usr/bin/busctl', { PATH: '/tmp/.mount_x/usr/bin:/usr/bin', APPDIR: '/tmp/.mount_x', HOME: '/h' }, ok);
    await run(['--user', 'x']);
    expect(seen).toEqual([{ file: '/usr/bin/busctl', args: ['--user', 'x'], env: { PATH: '/usr/bin', HOME: '/h' }, timeout: 7000 }]);
    expect(() => createBusctl('busctl')).toThrow();
    const fail: ExecLike = (_f, _a, _o, cb) => { cb(Object.assign(new Error('x'), { killed: false }), '', 'Call failed: Access denied\n'); return null; };
    await expect(createBusctl('/usr/bin/busctl', {}, fail)([])).rejects.toMatchObject({ code: 'denied', message: 'Call failed: Access denied' });
  });

  test('client : ensureSlice retombe sur SetUnitProperties si la slice existe ; compteur d’appels ; nom refusé → rejet sans appel', async () => {
    const argvs: string[][] = [];
    const client = createSystemdClient(async (argv) => {
      argvs.push([...argv]);
      if (argv.includes('StartTransientUnit')) throw new BusctlError('Unit cwatch.slice already exists.', 'exists');
    });
    await client.ensureSlice('cwatch.slice', L);
    expect(argvs.map((a) => a[6])).toEqual(['StartTransientUnit', 'SetUnitProperties']);
    expect(client.calls()).toBe(2);
    await expect(client.attach('../x.scope', [700])).rejects.toThrow();
    expect(client.calls()).toBe(2);
    expect(MiB).toBe(1024 * 1024);
  });
});
