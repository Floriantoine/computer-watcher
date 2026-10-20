import { describe, expect, test } from 'vitest';
import type { ProcInfo } from '../types';
import {
  DESK_CPU_WEIGHT, MAX_TERMINAL_UNITS, SESSION_SLICE, TERMINAL_CPU_WEIGHT, WORK_CPU_WEIGHT, deskTargets, isDeskSliceName,
  isDeskUnitName, terminalUnitOf,
} from './deskUnits';

const BASE = '/user.slice/user-1000.slice/user@1000.service';
const WARP_UNIT = 'app-dev.warp.Warp@bee3f2ded2d04c3db563057c8e73379d.service';
const WARP = `${BASE}/app.slice/${WARP_UNIT}`;
const R = 4 * 1024 ** 3;

let st = 1;
const p = (pid: number, name: string, cmdline = name, o: Partial<ProcInfo> = {}): ProcInfo => ({
  pid, ppid: 1, name, cmdline, uid: 1000, startTicks: st++, ageSec: 100, cpuTicks: 0, cpuPercent: 0, rssKB: 1000, swapKB: 0, cwd: null, cwdDeleted: false, ...o,
});
const caps = { cpu: true, io: false, memory: false };
const targets = (procs: ProcInfo[], cg: Record<number, string>, o: Partial<Parameters<typeof deskTargets>[0]> = {}) =>
  deskTargets({ procs, uid: 1000, userBase: BASE, cgroupOf: (pid) => cg[pid] ?? null, reserveBytes: R, caps, rootExists: true, ...o });

describe('noms des unités du bureau', () => {
  test('slices et unités réelles acceptées, échappements \\xNN compris', () => {
    for (const s of ['session.slice', 'app.slice', 'app-dev.warp.Warp.slice', 'background.slice']) expect(isDeskSliceName(s), s).toBe(true);
    for (const u of [WARP_UNIT, 'app-computer\\x2dwatcher-2851454.scope', 'app-org.kde.konsole-42.scope', 'tmux-spawn-1a2b.scope']) {
      expect(isDeskUnitName(u), u).toBe(true);
    }
  });

  test('refusés : cwatch…, init.scope, -.slice, chemins, espaces, échappements invalides, mauvais suffixe, trop long', () => {
    for (const s of ['cwatch.slice', 'cwatch-p-alpha.slice', 'cwatch-e2eabc.slice', '-.slice', 'a/b.slice', 'a b.slice', '.slice', 'a@b.slice', 'x\\y.slice', 'x\\x2.slice', `${'a'.repeat(250)}.slice`, 'app.service', '', 42]) {
      expect(isDeskSliceName(s), String(s)).toBe(false);
    }
    for (const u of ['init.scope', 'cwatch-p-alpha-1.scope', 'a/b.service', 'a b.service', 'x.slice', 'x.socket', '..service', `${'a'.repeat(250)}.service`, 'a\nb.service', null]) {
      expect(isDeskUnitName(u), String(u)).toBe(false);
    }
  });
});

describe('unité d’un terminal', () => {
  test('premier segment .service/.scope après des slices ; sous-cgroups délégués ignorés', () => {
    expect(terminalUnitOf(WARP, BASE)).toEqual({ slices: ['app.slice'], unit: WARP_UNIT });
    expect(terminalUnitOf(`${BASE}/app.slice/app-x.slice/a.scope/sub/deeper`, BASE)).toEqual({ slices: ['app.slice', 'app-x.slice'], unit: 'a.scope' });
  });

  test('refus : hors de user@, sous cwatch.slice, unité sans slice, slice imbriquée incohérente, segment invalide, « .. »', () => {
    expect(terminalUnitOf('/system.slice/x.service', BASE)).toBeNull();
    expect(terminalUnitOf(`${BASE}x/app.slice/a.service`, BASE)).toBeNull();
    expect(terminalUnitOf(`${BASE}/cwatch.slice/cwatch-p.slice/cwatch-p-a.slice/cwatch-p-a-1.scope`, BASE)).toBeNull();
    expect(terminalUnitOf(`${BASE}/init.scope`, BASE)).toBeNull();
    expect(terminalUnitOf(`${BASE}/a.service`, BASE)).toBeNull();
    expect(terminalUnitOf(`${BASE}/app.slice/other-x.slice/a.service`, BASE)).toBeNull();
    expect(terminalUnitOf(`${BASE}/app.slice/../session.slice/a.service`, BASE)).toBeNull();
    expect(terminalUnitOf(`${BASE}/app.slice`, BASE)).toBeNull();
    expect(terminalUnitOf(`${BASE}/app.slice/a b.service`, BASE)).toBeNull();
    expect(terminalUnitOf(null, BASE)).toBeNull();
  });
});

describe('cibles du bureau prioritaire', () => {
  test('Warp et Claude dans la même unité : session.slice 200, app.slice 150, cwatch.slice 50 ; pas de poids sur l’unité de Warp', () => {
    const t = targets([p(10, 'warp'), p(11, 'zsh'), p(12, 'claude')], { 10: WARP, 11: WARP, 12: WARP });
    expect([...t.units.keys()]).toEqual(['session.slice', 'app.slice', 'cwatch.slice']);
    expect(t.units.get(SESSION_SLICE)).toEqual({ cgroup: `${BASE}/session.slice`, cpuWeight: DESK_CPU_WEIGHT });
    expect(t.units.get('app.slice')).toEqual({ cgroup: `${BASE}/app.slice`, cpuWeight: TERMINAL_CPU_WEIGHT });
    expect(t.units.get('cwatch.slice')).toEqual({ cgroup: `${BASE}/cwatch.slice`, cpuWeight: WORK_CPU_WEIGHT });
    expect(t.terminals).toEqual([WARP_UNIT]);
  });

  test('protection mémoire efficace : MemoryLow = réserve (alignée) sur session.slice, la chaîne de slices et l’unité ; jamais sur cwatch.slice', () => {
    const t = targets([p(10, 'warp')], { 10: WARP }, { caps: { cpu: true, io: true, memory: true }, reserveBytes: R + 100 });
    expect(t.units.get(SESSION_SLICE)).toEqual({ cgroup: `${BASE}/session.slice`, cpuWeight: 200, ioWeight: 200, memoryLow: R });
    expect(t.units.get('app.slice')).toEqual({ cgroup: `${BASE}/app.slice`, cpuWeight: 150, ioWeight: 150, memoryLow: R });
    expect(t.units.get(WARP_UNIT)).toEqual({ cgroup: WARP, memoryLow: R });
    expect(t.units.get('cwatch.slice')).toEqual({ cgroup: `${BASE}/cwatch.slice`, cpuWeight: 50, ioWeight: 50 });
  });

  test('sans cpu ni io délégués et protection sans effet : rien à poser', () => {
    const t = targets([p(10, 'warp')], { 10: WARP }, { caps: { cpu: false, io: false, memory: false } });
    expect(t.units.size).toBe(0);
  });

  test('cwatch.slice absente : pas de poids pour elle ce tick', () => {
    expect(targets([], {}, { rootExists: false }).units.has('cwatch.slice')).toBe(false);
  });

  test('terminal dans session.slice : poids du bureau gardé (le plus haut)', () => {
    const cg = `${BASE}/session.slice/konsole.service`;
    const t = targets([p(10, 'konsole')], { 10: cg });
    expect(t.units.get(SESSION_SLICE)?.cpuWeight).toBe(DESK_CPU_WEIGHT);
  });

  test('plusieurs terminaux : toutes leurs unités, ordre stable, 6 au plus', () => {
    const procs: ProcInfo[] = [];
    const cg: Record<number, string> = {};
    for (let i = 0; i < 9; i++) {
      procs.push(p(100 + i, 'kitty'));
      cg[100 + i] = `${BASE}/app.slice/app-kitty-${9 - i}.scope`;
    }
    const t = targets(procs, cg, { caps: { cpu: true, io: false, memory: true } });
    expect(t.terminals).toHaveLength(MAX_TERMINAL_UNITS);
    expect(t.terminals[0]).toBe('app-kitty-1.scope');
    expect(t.truncated).toBe(true);
    expect(t.units.get('app-kitty-1.scope')?.memoryLow).toBe(R);
    expect(t.units.has('app-kitty-9.scope')).toBe(false);
  });

  test('ignorés : autre utilisateur, zombie, processus ordinaires, terminal déplacé sous cwatch, cgroup illisible', () => {
    const t = targets(
      [p(10, 'warp', 'warp', { uid: 0 }), p(11, 'kitty', '[kitty]'), p(12, 'node', 'node x.js'), p(13, 'kitty'), p(14, 'claude')],
      { 10: WARP, 11: WARP, 12: WARP, 13: `${BASE}/cwatch.slice/cwatch-p.slice/cwatch-p-a.slice/cwatch-p-a-1.scope` },
    );
    expect(t.terminals).toEqual([]);
    expect(t.units.has('app.slice')).toBe(false);
  });

  test('Claude reconnu au programme lancé (claude-desktop)', () => {
    const cg = `${BASE}/app.slice/app-com.anthropic.Claude-12.scope`;
    expect(targets([p(10, 'claude-desktop', '/opt/claude/claude-desktop --x')], { 10: cg }).terminals).toEqual(['app-com.anthropic.Claude-12.scope']);
  });
});
