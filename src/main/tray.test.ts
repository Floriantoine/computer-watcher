import { describe, expect, test, vi } from 'vitest';
import type { SystemInfo } from '../core/types';
import { closeAction, createTrayController, statusNotifierAvailable, TRAY_EVERY_MS, type TrayDeps, type TrayMenuItem } from './tray';

const GB = 1024 * 1024;
const base: SystemInfo = {
  memTotalKB: 100 * GB, memAvailableKB: 58 * GB, swapTotalKB: 10 * GB, swapFreeKB: 10 * GB, load1: 1, psiSome10: 0, shmemKB: 0,
};

function setup(initial: SystemInfo = base) {
  let system = initial;
  const counts = { create: 0, setImage: 0, setContextMenu: 0, setToolTip: 0, destroy: 0 };
  const images: Buffer[] = [];
  let menuItems: TrayMenuItem[] = [];
  let clickCb: (() => void) | null = null;
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const deps: TrayDeps = {
    createTray: (img) => {
      counts.create++;
      images.push(img as Buffer);
      return {
        setImage: (i) => {
          counts.setImage++;
          images.push(i as Buffer);
        },
        setToolTip: () => void counts.setToolTip++,
        setContextMenu: (m) => {
          counts.setContextMenu++;
          menuItems = m as TrayMenuItem[];
        },
        on: (_ev, cb) => void (clickCb = cb),
        destroy: () => void counts.destroy++,
      };
    },
    image: (png) => png,
    menu: (items) => items,
    readSystem: () => system,
    setInterval: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearInterval: (h) => void ((h as { cleared: boolean }).cleared = true),
    onOpen: vi.fn(),
    onFree: vi.fn(),
    onQuit: vi.fn(),
  };
  const ctl = createTrayController(deps);
  return {
    ctl, deps, counts, images, timers,
    menu: () => menuItems,
    click: () => clickCb?.(),
    set: (s: SystemInfo) => void (system = s),
  };
}

describe('createTrayController', () => {
  test('création : une icône, un menu, pas de redessin si rien ne change', () => {
    const t = setup();
    expect(t.counts.create).toBe(1);
    expect(t.counts.setContextMenu).toBe(1);
    t.ctl.update();
    t.ctl.update();
    expect(t.counts.setImage).toBe(0);
    expect(t.counts.setContextMenu).toBe(1);
    expect(t.ctl.stats()).toEqual({ redraws: 1, menus: 1 });
  });
  test('RAM +1 % dans la même tranche : ni icône ni menu (libellés en Go identiques à 0,1 près) ; +6 % : redessin', () => {
    const t = setup();
    t.set({ ...base, memAvailableKB: base.memAvailableKB - 0.01 * GB }); // 42,01 % → même tranche, même libellé « 42,0 Go »
    t.ctl.update();
    expect(t.ctl.stats()).toEqual({ redraws: 1, menus: 1 });
    t.set({ ...base, memAvailableKB: base.memAvailableKB - 1 * GB }); // 43 % : même tranche (40), libellé RAM change
    t.ctl.update();
    expect(t.counts.setImage).toBe(0);
    expect(t.ctl.stats().menus).toBe(2);
    t.set({ ...base, memAvailableKB: base.memAvailableKB - 6 * GB }); // 48 % → tranche 45
    t.ctl.update();
    expect(t.counts.setImage).toBe(1);
    expect(t.ctl.stats().redraws).toBe(2);
  });
  test('swap de 49 à 71 % : nouvelle couleur → redessin', () => {
    const t = setup({ ...base, swapFreeKB: 5.1 * GB });
    t.set({ ...base, swapFreeKB: 2.9 * GB });
    t.ctl.update();
    expect(t.counts.setImage).toBe(1);
    expect(t.images[0]!.equals(t.images[1]!)).toBe(false);
  });
  test('intervalle armé à 10 s, il appelle update ; stop() l\'arrête et détruit l\'icône', () => {
    const t = setup();
    expect(TRAY_EVERY_MS).toBe(10_000);
    expect(t.timers).toHaveLength(1);
    expect(t.timers[0]!.ms).toBe(10_000);
    t.set({ ...base, memAvailableKB: 10 * GB });
    t.timers[0]!.fn();
    expect(t.counts.setImage).toBe(1);
    t.ctl.stop();
    expect(t.timers[0]!.cleared).toBe(true);
    expect(t.counts.destroy).toBe(1);
    t.ctl.stop();
    expect(t.counts.destroy).toBe(1);
  });
  test('menu : libellés puis actions, dans l\'ordre de la spec', () => {
    const t = setup();
    const m = t.menu();
    expect(m.map((i) => (i.type === 'separator' ? '—' : i.label))).toEqual([
      'RAM 42,0 Go · Swap 0,0 Go', 'Pression 0 % · Charge 1,0', '—', 'Ouvrir proc-watch', 'Libérer de la mémoire…', '—', 'Quitter',
    ]);
    expect(m[0]!.enabled).toBe(false);
    expect(m[1]!.enabled).toBe(false);
    m[3]!.click!();
    expect(t.deps.onOpen).toHaveBeenCalledTimes(1);
    m[4]!.click!();
    expect(t.deps.onFree).toHaveBeenCalledTimes(1);
    m[6]!.click!();
    expect(t.deps.onQuit).toHaveBeenCalledTimes(1);
  });
  test('clic sur l\'icône → ouvrir', () => {
    const t = setup();
    t.click();
    expect(t.deps.onOpen).toHaveBeenCalledTimes(1);
  });
  test('lecture du système en erreur : aucune exception, icône inchangée', () => {
    const t = setup();
    t.deps.readSystem = () => {
      throw new Error('EACCES');
    };
    expect(() => t.ctl.update()).not.toThrow();
    expect(t.counts.setImage).toBe(0);
  });
});

describe('statusNotifierAvailable', () => {
  test('NameHasOwner du watcher KDE sur le bus de session', async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: 'b true\n' }));
    expect(await statusNotifierAvailable(run)).toBe(true);
    expect(run).toHaveBeenCalledWith('busctl', [
      '--user', 'call', 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner', 's', 'org.kde.StatusNotifierWatcher',
    ]);
  });
  test('b false → faux', async () => {
    expect(await statusNotifierAvailable(async () => ({ ok: true, stdout: 'b false\n' }))).toBe(false);
  });
  test('busctl absent ou bus inaccessible → faux', async () => {
    expect(await statusNotifierAvailable(async () => ({ ok: false, stdout: '' }))).toBe(false);
    expect(await statusNotifierAvailable(async () => Promise.reject(new Error('ENOENT')))).toBe(false);
  });
});

describe('closeAction', () => {
  test('sans zone de notification, fermer quitte (Review Focus 3)', () => {
    expect(closeAction({ closeToTray: true, trayActive: false, quitting: false })).toBe('close');
  });
  test('icône active et réglage actif → cacher', () => {
    expect(closeAction({ closeToTray: true, trayActive: true, quitting: false })).toBe('hide');
  });
  test('« Quitter » en cours → fermer', () => {
    expect(closeAction({ closeToTray: true, trayActive: true, quitting: true })).toBe('close');
  });
  test('réglage coupé → fermer', () => {
    expect(closeAction({ closeToTray: false, trayActive: true, quitting: false })).toBe('close');
  });
});
