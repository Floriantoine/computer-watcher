import { describe, expect, test } from 'vitest';
import { filterTargets, isNeverKill, NEVER_KILL, type GuardContext, type GuardProc } from './neverKill';

const p = (name: string, cmdline = name) => ({ name, cmdline });

describe('isNeverKill', () => {
  test('chaque nom exact de la liste → vrai', () => {
    for (const e of NEVER_KILL) if (typeof e === 'string') expect(isNeverKill(p(e, ''), null), e).toBe(true);
  });
  test.each([
    'claude', 'claude-desktop', 'warp', 'zsh', 'bash', 'fish', 'sh', 'konsole', 'kwin_wayland', 'kwin_wayland_wr', 'plasmashell',
    'Xwayland', 'sddm', 'systemd', 'systemd-journald', 'systemd-oomd', 'dbus-daemon', 'dbus-broker', 'pipewire', 'pipewire-pulse',
    'earlyoom', 'proc-watch',
  ])('%s → vrai', (name) => {
    expect(isNeverKill(p(name), null)).toBe(true);
  });
  test('node, vitest, chrome → faux', () => {
    for (const n of ['node', 'vitest', 'chrome', 'python3']) expect(isNeverKill(p(n, `/usr/bin/${n} x.js`), null)).toBe(false);
  });
  test('casse différente (Claude) → faux : noms exacts, comme earlyoom', () => {
    expect(isNeverKill(p('Claude', 'Claude'), null)).toBe(false);
  });
  test("ligne de commande de l'app empaquetée → vrai", () => {
    expect(isNeverKill(p('electron', '/opt/proc-watch/proc-watch --type=renderer'), null)).toBe(true);
  });
  test("ligne de commande de l'app en dev (appRoot) → vrai", () => {
    expect(isNeverKill(p('electron', 'electron /home/u/Delivery/app-x'), '/home/u/Delivery/app-x')).toBe(true);
    expect(isNeverKill(p('electron', 'electron --app-path=/home/u/Delivery/app-x/.worktrees/w'), '/home/u/Delivery/app-x')).toBe(true);
    expect(isNeverKill(p('electron', 'electron /home/u/Delivery/proc-watch'), null)).toBe(true);
    expect(isNeverKill(p('electron', 'electron /home/u/Delivery/app-xy'), '/home/u/Delivery/app-x')).toBe(false);
  });
  test('service : node …/out/main/recorder.js → vrai', () => {
    expect(isNeverKill(p('node', 'node /x/out/main/recorder.js'), null)).toBe(true);
  });
  test('Claude lancé par node (argv0 claude) → vrai', () => {
    expect(isNeverKill(p('node', '/home/u/.local/bin/claude --resume'), null)).toBe(true);
  });
});

describe('filterTargets', () => {
  const procs: GuardProc[] = [
    { pid: 1, ppid: 0, name: 'systemd', cmdline: '/sbin/init', uid: 0 },
    { pid: 500, ppid: 1, name: 'systemd', cmdline: 'systemd --user', uid: 1000 },
    { pid: 900, ppid: 500, name: 'node', cmdline: 'node /x/out/main/recorder.js', uid: 1000 },
    { pid: 600, ppid: 500, name: 'warp', cmdline: 'warp', uid: 1000 },
    { pid: 601, ppid: 600, name: 'zsh', cmdline: 'zsh', uid: 1000 },
    { pid: 602, ppid: 601, name: 'node', cmdline: 'node vitest', uid: 1000 },
    { pid: 603, ppid: 602, name: 'node', cmdline: 'node worker', uid: 1000 },
    { pid: 700, ppid: 601, name: 'claude', cmdline: 'claude', uid: 1000 },
    { pid: 701, ppid: 700, name: 'node', cmdline: 'node vite', uid: 1000 },
    { pid: 800, ppid: 500, name: 'npm', cmdline: 'npm run dev', uid: 1000 },
    { pid: 801, ppid: 800, name: 'sh', cmdline: 'sh -c vite', uid: 1000 },
    { pid: 802, ppid: 801, name: 'node', cmdline: 'node vite', uid: 1000 },
    { pid: 810, ppid: 500, name: 'node', cmdline: 'node other', uid: 1001 },
    { pid: 811, ppid: 1, name: 'node', cmdline: 'node root', uid: 0 },
    { pid: 820, ppid: 500, name: 'postgres', cmdline: 'postgres', uid: 1000 },
  ];
  const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({
    byPid: new Map(procs.map((x) => [x.pid, x])), currentUid: 1000, selfPid: 900, appRoot: null, isProtected: (n) => n === 'postgres', ...over,
  });

  test('vitest et son worker sous zsh → gardés (un shell ancêtre ne protège pas ses enfants)', () => {
    expect(filterTargets([602, 603], ctx()).kept).toEqual([602, 603]);
  });
  test('shell, terminal, Claude → refusés ; descendant de Claude → refusé', () => {
    const r = filterTargets([600, 601, 700, 701], ctx());
    expect(r.kept).toEqual([]);
    expect(Object.fromEntries(r.refused)).toEqual({ 600: 'never-kill', 601: 'never-kill', 700: 'never-kill', 701: 'claude' });
  });
  test('lanceur dont un descendant est intouchable (npm → sh) → refusé ; la feuille reste', () => {
    const r = filterTargets([800, 801, 802], ctx());
    expect(r.kept).toEqual([802]);
    expect(r.refused.get(800)).toBe('launcher');
    expect(r.refused.get(801)).toBe('never-kill');
  });
  test('autre utilisateur, root, protégé, service et ses ancêtres, pid inconnu → refusés', () => {
    const r = filterTargets([810, 811, 820, 900, 500, 1, 12345], ctx());
    expect(r.kept).toEqual([]);
    expect(Object.fromEntries(r.refused)).toEqual({ 810: 'uid', 811: 'root', 820: 'protected', 900: 'self', 500: 'self', 1: 'self', 12345: 'unknown' });
  });
});
