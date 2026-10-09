import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { appLauncher, appLaunchCommand, launchApp } from './launchApp';

const onDisk = (paths: string[]) => (p: string): boolean => paths.includes(p);

describe('appLauncher', () => {
  test('AppImage : le fichier AppImage, sans argument', () => {
    expect(appLauncher({ appImage: '/home/u/proc-watch.AppImage', execPath: '/tmp/.mount_x/proc-watch', recorderScript: undefined, uid: 1000, isFile: onDisk(['/home/u/proc-watch.AppImage']) }))
      .toEqual({ cmd: '/home/u/proc-watch.AppImage', args: [] });
  });

  test('clone (electron-vite preview) : electron + racine de l’app (out/main/recorder.js → /x)', () => {
    expect(appLauncher({ execPath: '/x/node_modules/electron/dist/electron', recorderScript: '/x/out/main/recorder.js', uid: 1000, isFile: onDisk(['/x/node_modules/electron/dist/electron', '/x/out/main/index.js']) }))
      .toEqual({ cmd: '/x/node_modules/electron/dist/electron', args: ['/x'] });
  });

  test('paquet .deb (app.asar) : le binaire empaqueté seul', () => {
    expect(appLauncher({ execPath: '/opt/proc-watch/proc-watch', recorderScript: '/opt/proc-watch/resources/app.asar/out/main/recorder.js', uid: 1000, isFile: onDisk(['/opt/proc-watch/proc-watch']) }))
      .toEqual({ cmd: '/opt/proc-watch/proc-watch', args: [] });
  });

  test.each([
    ['root : jamais de lancement (autre utilisateur)', { execPath: '/x/electron', recorderScript: '/x/out/main/recorder.js', uid: 0, isFile: (): boolean => true }],
    ['app non construite', { execPath: '/x/electron', recorderScript: '/x/out/main/recorder.js', uid: 1000, isFile: onDisk(['/x/electron']) }],
    ['script inconnu', { execPath: '/x/electron', recorderScript: undefined, uid: 1000, isFile: (): boolean => true }],
    ['APPIMAGE relatif', { appImage: 'proc-watch.AppImage', execPath: '/x/electron', recorderScript: undefined, uid: 1000, isFile: (): boolean => true }],
    ['AppImage disparue', { appImage: '/gone.AppImage', execPath: '/x/electron', recorderScript: undefined, uid: 1000, isFile: (): boolean => false }],
  ])('introuvable → null : %s', (_l, p) => {
    expect(appLauncher(p)).toBeNull();
  });
});

describe('appLaunchCommand', () => {
  const l = { cmd: '/x/electron', args: ['/x'] };
  test('avec systemd-run : unité transitoire de l’utilisateur, hors du cgroup du service', () => {
    expect(appLaunchCommand(l, ['--alert=42'], '/usr/bin/systemd-run')).toEqual({
      cmd: '/usr/bin/systemd-run', args: ['--user', '--collect', '--quiet', '--', '/x/electron', '/x', '--alert=42'], timeoutMs: 10_000,
    });
  });
  test('sans systemd-run : lancement direct', () => {
    expect(appLaunchCommand(l, ['--alert=42'], null)).toEqual({ cmd: '/x/electron', args: ['/x', '--alert=42'] });
  });
});

describe('launchApp', () => {
  const fakeSpawn = () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const spawn = vi.fn(() => child);
    return { spawn, child };
  };

  test('détaché, sans ELECTRON_RUN_AS_NODE, unref', () => {
    const { spawn, child } = fakeSpawn();
    launchApp({ cmd: '/x/electron', args: ['/x', '--alert=1'] }, { spawn: spawn as never, env: { ELECTRON_RUN_AS_NODE: '1', HOME: '/home/u' }, log: () => {} });
    expect(spawn).toHaveBeenCalledWith('/x/electron', ['/x', '--alert=1'], { detached: true, stdio: 'ignore', env: { HOME: '/home/u' } });
    expect(child.unref).toHaveBeenCalled();
  });

  test('I-A : app lancée par le service : environnement sans entrée sous le montage /tmp de l’AppImage du service', () => {
    const { spawn } = fakeSpawn();
    const M = '/tmp/.mount_proc-wX';
    launchApp({ cmd: '/a.AppImage', args: [] }, { spawn: spawn as never, env: { APPDIR: M, APPIMAGE: '/a.AppImage', PATH: `${M}:/usr/bin`, LD_LIBRARY_PATH: `${M}/usr/lib`, HOME: '/h' }, log: () => {} });
    const env = (spawn.mock.calls[0] as unknown[])[2] as { env: Record<string, string> };
    expect(env.env).toEqual({ PATH: '/usr/bin', HOME: '/h' });
  });

  test('systemd-run qui ne rend pas la main : tué après timeoutMs ; sorti à temps : rien', () => {
    vi.useFakeTimers();
    try {
      const a = fakeSpawn();
      const kill = vi.fn();
      Object.assign(a.child, { kill });
      launchApp({ cmd: '/usr/bin/systemd-run', args: [], timeoutMs: 10_000 }, { spawn: a.spawn as never, env: {}, log: () => {} });
      vi.advanceTimersByTime(9_999);
      expect(kill).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(kill).toHaveBeenCalledWith('SIGKILL');
      const b = fakeSpawn();
      const kill2 = vi.fn();
      Object.assign(b.child, { kill: kill2 });
      launchApp({ cmd: '/usr/bin/systemd-run', args: [], timeoutMs: 10_000 }, { spawn: b.spawn as never, env: {}, log: () => {} });
      b.child.emit('exit', 0);
      vi.advanceTimersByTime(20_000);
      expect(kill2).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('lancement direct (l’app elle-même) : jamais tué', () => {
    vi.useFakeTimers();
    try {
      const a = fakeSpawn();
      const kill = vi.fn();
      Object.assign(a.child, { kill });
      launchApp({ cmd: '/x/electron', args: [] }, { spawn: a.spawn as never, env: {}, log: () => {} });
      vi.advanceTimersByTime(3_600_000);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('erreur de spawn → journal, pas d’exception', () => {
    const { spawn, child } = fakeSpawn();
    const log = vi.fn();
    launchApp({ cmd: '/x/electron', args: [] }, { spawn: spawn as never, env: {}, log });
    expect(() => child.emit('error', new Error('ENOENT'))).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
  });

  test('spawn qui lève → journal, pas d’exception', () => {
    const log = vi.fn();
    const spawn = vi.fn(() => {
      throw new Error('EACCES');
    });
    expect(() => launchApp({ cmd: '/x/electron', args: [] }, { spawn: spawn as never, env: {}, log })).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
  });
});
