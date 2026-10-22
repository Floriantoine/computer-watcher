import { describe, expect, test } from 'vitest';
import { createBusctlSync, createFridgeClient, freezeArgv, liftSwapArgv, thawArgv } from './fridgeSystemd';
import { INFINITY_T } from './limits';
import { BusctlError } from './systemd';

const HEAD = ['--user', '--timeout=5', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager'];

describe('argv FreezeUnit / ThawUnit', () => {
  test('slice de projet (production ou test) seulement', () => {
    expect(freezeArgv('cwatch-p-alpha.slice')).toEqual([...HEAD, 'FreezeUnit', 's', 'cwatch-p-alpha.slice']);
    expect(thawArgv('cwatch-p-alpha_0a1b2c.slice')).toEqual([...HEAD, 'ThawUnit', 's', 'cwatch-p-alpha_0a1b2c.slice']);
    expect(freezeArgv('cwatch-e2eab12-a.slice')).toContain('cwatch-e2eab12-a.slice');
  });

  test('part de swap levée pendant le frigo : SetUnitProperties MemorySwapMax=infinity sur la slice du projet, rien d’autre', () => {
    expect(liftSwapArgv('cwatch-p-alpha.slice')).toEqual([...HEAD, 'SetUnitProperties', 'sba(sv)', 'cwatch-p-alpha.slice', 'true', '1', 'MemorySwapMax', 't', INFINITY_T]);
    expect(liftSwapArgv('cwatch-e2eab12-a.slice')).toContain('cwatch-e2eab12-a.slice');
  });

  test('refus : cwatch.slice, slices et unités hors cwatch, scopes, noms piégés', () => {
    for (const u of ['cwatch.slice', 'cwatch-e2eab12.slice', 'app.slice', 'session.slice', 'user.slice', 'cwatch-p.slice', 'cwatch-p-alpha-a1.scope',
      'app-dev.warp.Warp@1.service', '../cwatch-p-alpha.slice', 'cwatch-p-alpha.slice ', 'cwatch-p-Alpha.slice', '-.slice', '']) {
      expect(() => freezeArgv(u), u).toThrow();
      expect(() => thawArgv(u), u).toThrow();
      expect(() => liftSwapArgv(u), u).toThrow();
    }
  });
});

describe('client du frigo', () => {
  test('un nom refusé ne lance rien ni ne compte', async () => {
    const seen: (readonly string[])[] = [];
    const c = createFridgeClient(async (a) => { seen.push(a); }, (a) => { seen.push(a); });
    await expect(c.freeze('cwatch.slice')).rejects.toThrow();
    expect(() => c.thawSync('app.slice')).toThrow();
    expect(c.calls()).toBe(0);
    await expect(c.liftSwap('cwatch.slice')).rejects.toThrow();
    expect(c.calls()).toBe(0);
    await c.freeze('cwatch-p-alpha.slice');
    await c.liftSwap('cwatch-p-alpha.slice');
    await c.thaw('cwatch-p-alpha.slice');
    c.thawSync('cwatch-p-alpha.slice');
    expect(c.calls()).toBe(4);
    expect(seen.map((a) => a[6])).toEqual(['FreezeUnit', 'SetUnitProperties', 'ThawUnit', 'ThawUnit']);
  });
});

describe('busctl synchrone', () => {
  test('chemin absolu seulement, argv vérifié, environnement nettoyé, délai borné', () => {
    expect(() => createBusctlSync('busctl')).toThrow();
    expect(() => createBusctlSync('/usr/local/bin/busctl')).toThrow();
    const got: unknown[][] = [];
    const run = createBusctlSync('/usr/bin/busctl', { PATH: '/usr/bin', APPDIR: '/tmp/.mount_ab12', LD_LIBRARY_PATH: '/tmp/.mount_ab12/usr/lib' } as NodeJS.ProcessEnv, (f, a, o) => {
      got.push([f, a, o]);
      return '';
    });
    expect(() => run(['--system', 'call'])).toThrow(/argv refusé/);
    expect(got).toHaveLength(0);
    run(thawArgv('cwatch-p-alpha.slice'));
    const [file, args, opts] = got[0] as [string, string[], { env: NodeJS.ProcessEnv; timeout: number }];
    expect(file).toBe('/usr/bin/busctl');
    expect(args[0]).toBe('--user');
    expect(opts.timeout).toBe(7000);
    expect(opts.env.LD_LIBRARY_PATH).toBeUndefined();
  });

  test('erreurs classées comme la version asynchrone', () => {
    const fail = (e: object) => createBusctlSync('/usr/bin/busctl', {}, () => { throw Object.assign(new Error('x'), e); });
    const code = (e: object) => {
      try {
        fail(e)(thawArgv('cwatch-p-alpha.slice'));
      } catch (x) {
        return x instanceof BusctlError ? x.code : 'pas une BusctlError';
      }
      return 'aucune';
    };
    expect(code({ stderr: 'Call failed: Unit cwatch-p-alpha.slice not loaded.' })).toBe('no-unit');
    expect(code({ code: 'ENOENT' })).toBe('unreachable');
    expect(code({ code: 'ETIMEDOUT' })).toBe('timeout');
    expect(code({ stderr: 'Access denied' })).toBe('denied');
  });
});
