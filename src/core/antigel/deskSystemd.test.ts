import { describe, expect, test } from 'vitest';
import { INFINITY_T } from './limits';
import { createDeskClient, setDeskPropsArgv } from './deskSystemd';

const HEAD = ['--user', '--timeout=5', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager'];
const WARP = 'app-dev.warp.Warp@bee3f2ded2d04c3db563057c8e73379d.service';

describe('argv du bureau prioritaire', () => {
  test('SetUnitProperties runtime, ordre fixe MemoryLow, CPUWeight, IOWeight ; null : infinity ou « non défini »', () => {
    expect(setDeskPropsArgv('session.slice', { cpuWeight: 200, memoryLow: 4096, ioWeight: 200 })).toEqual([
      ...HEAD, 'SetUnitProperties', 'sba(sv)', 'session.slice', 'true', '3', 'MemoryLow', 't', '4096', 'CPUWeight', 't', '200', 'IOWeight', 't', '200',
    ]);
    expect(setDeskPropsArgv(WARP, { memoryLow: null })).toEqual([...HEAD, 'SetUnitProperties', 'sba(sv)', WARP, 'true', '1', 'MemoryLow', 't', INFINITY_T]);
    expect(setDeskPropsArgv('app.slice', { cpuWeight: null, ioWeight: null }).slice(-6)).toEqual(['CPUWeight', 't', INFINITY_T, 'IOWeight', 't', INFINITY_T]);
    expect(setDeskPropsArgv('session.slice', { memoryLow: 0 }).slice(-3)).toEqual(['MemoryLow', 't', '0']);
  });

  test('cwatch.slice : poids seulement, jamais de protection mémoire ; unités de projet refusées', () => {
    expect(setDeskPropsArgv('cwatch.slice', { cpuWeight: 50 }).slice(-6)).toEqual(['cwatch.slice', 'true', '1', 'CPUWeight', 't', '50']);
    expect(() => setDeskPropsArgv('cwatch.slice', { memoryLow: 4096 })).toThrow();
    expect(() => setDeskPropsArgv('cwatch-p-alpha.slice', { cpuWeight: 50 })).toThrow();
    expect(() => setDeskPropsArgv('cwatch-p-alpha-a1.scope', { memoryLow: 0 })).toThrow();
  });

  test('unités de test (e2e) : protection et poids acceptés', () => {
    expect(setDeskPropsArgv('cwatch-e2eab12.slice', { cpuWeight: 50, memoryLow: 4096 })).toContain('MemoryLow');
    expect(setDeskPropsArgv('cwatch-e2eab12-a.scope', { memoryLow: 4096 })).toContain('cwatch-e2eab12-a.scope');
  });

  test('refus : nom invalide, aucune propriété, propriété inconnue, poids 0 (idle) ou hors bornes, taille négative ou non entière', () => {
    for (const bad of ['init.scope', '-.slice', 'a/b.slice', 'x.socket', '']) expect(() => setDeskPropsArgv(bad, { cpuWeight: 100 }), bad).toThrow();
    expect(() => setDeskPropsArgv('session.slice', {})).toThrow();
    expect(() => setDeskPropsArgv('session.slice', { MemoryMax: 1 } as never)).toThrow();
    expect(() => setDeskPropsArgv('session.slice', { cpuWeight: 0 })).toThrow();
    expect(() => setDeskPropsArgv('session.slice', { cpuWeight: 10_001 })).toThrow();
    expect(() => setDeskPropsArgv('session.slice', { ioWeight: 1.5 })).toThrow();
    expect(() => setDeskPropsArgv('session.slice', { memoryLow: -1 })).toThrow();
    expect(() => setDeskPropsArgv('session.slice', { memoryLow: 2 ** 60 })).toThrow();
  });
});

describe('client du bureau prioritaire', () => {
  test('argv validé avant le comptage : un nom refusé ne lance rien', async () => {
    const seen: string[][] = [];
    const c = createDeskClient(async (argv) => {
      seen.push([...argv]);
    });
    await c.setProps('session.slice', { cpuWeight: 200 });
    await expect(c.setProps('cwatch-p-a.slice', { cpuWeight: 50 })).rejects.toThrow();
    expect(c.calls()).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.slice(-3)).toEqual(['CPUWeight', 't', '200']);
  });
});
