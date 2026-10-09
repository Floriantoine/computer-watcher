import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SystemInfo } from '../core/types';
import {
  closeAction, confirmTray, createTrayController, menuKey, statusNotifierAvailable, TRAY_CHECK_MS, TRAY_EVERY_MS, type IconRep, type TrayDeps, type TrayMenuItem,
} from './tray';

const GB = 1024 * 1024;
const base: SystemInfo = {
  memTotalKB: 100 * GB, memAvailableKB: 58 * GB, swapTotalKB: 10 * GB, swapFreeKB: 10 * GB, load1: 1, psiSome10: 0, shmemKB: 0,
};

function setup(initial: SystemInfo = base, opts: { failFirstRead?: boolean } = {}) {
  let system = initial;
  let failNext = !!opts.failFirstRead;
  const counts = { create: 0, setImage: 0, setContextMenu: 0, setToolTip: 0, destroy: 0 };
  const images: IconRep[][] = [];
  let menuItems: TrayMenuItem[] = [];
  let clickCb: (() => void) | null = null;
  let menuShow: (() => void) | null = null;
  let menuHide: (() => void) | null = null;
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const deps: TrayDeps = {
    createTray: (img) => {
      counts.create++;
      images.push(img as IconRep[]);
      return {
        setImage: (i) => {
          counts.setImage++;
          images.push(i as IconRep[]);
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
    image: (reps) => reps,
    menu: (items) => items,
    watchMenu: (_m, onShow, onHide) => {
      menuShow = onShow;
      menuHide = onHide;
    },
    readSystem: () => {
      if (failNext) {
        failNext = false;
        throw new Error('EACCES');
      }
      return system;
    },
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
    openMenu: () => menuShow?.(),
    closeMenu: () => menuHide?.(),
    set: (s: SystemInfo) => void (system = s),
  };
}

describe('createTrayController', () => {
  beforeEach(() => void vi.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => void vi.restoreAllMocks());
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
  test('image en 1x (22 px) et 2x (44 px)', () => {
    const t = setup();
    const reps = t.images[0]!;
    expect(reps.map((r) => r.scaleFactor)).toEqual([1, 2]);
    expect(reps[0]!.png.readUInt32BE(16)).toBe(22);
    expect(reps[1]!.png.readUInt32BE(16)).toBe(44);
  });
  test('active() : vrai avec une icône, faux après stop()', () => {
    const t = setup();
    expect(t.ctl.active()).toBe(true);
    t.ctl.stop();
    expect(t.ctl.active()).toBe(false);
  });
  test('première lecture du système en erreur : pas d\'icône, active() faux, puis icône au tick suivant', () => {
    const t = setup(base, { failFirstRead: true });
    expect(t.counts.create).toBe(0);
    expect(t.ctl.active()).toBe(false);
    t.ctl.update();
    expect(t.counts.create).toBe(1);
    expect(t.ctl.active()).toBe(true);
  });
  test('icône : même tranche de 5 % → rien ; +6 % → redessin', () => {
    const t = setup();
    t.set({ ...base, memAvailableKB: base.memAvailableKB - 1 * GB }); // 43 % : même tranche (40)
    t.ctl.update();
    expect(t.counts.setImage).toBe(0);
    t.set({ ...base, memAvailableKB: base.memAvailableKB - 6 * GB }); // 48 % → tranche 45
    t.ctl.update();
    expect(t.counts.setImage).toBe(1);
    expect(t.ctl.stats().redraws).toBe(2);
  });
  test('menu refait seulement au pas de 0,5 Go (RAM, swap) et 0,5 (charge)', () => {
    const t = setup();
    t.set({ ...base, memAvailableKB: base.memAvailableKB - 0.2 * GB, load1: 1.2 }); // 42,2 Go, charge 1,2
    t.ctl.update();
    expect(t.ctl.stats().menus).toBe(1);
    t.set({ ...base, memAvailableKB: base.memAvailableKB - 0.6 * GB });
    t.ctl.update();
    expect(t.ctl.stats().menus).toBe(2);
    expect(t.menu()[0]!.label).toBe('RAM 42,6 Go · Swap 0,0 Go');
    t.set({ ...base, memAvailableKB: base.memAvailableKB - 0.6 * GB, load1: 1.6 });
    t.ctl.update();
    expect(t.ctl.stats().menus).toBe(3);
  });
  test('menu ouvert : pas de reconstruction, appliquée à sa fermeture', () => {
    const t = setup();
    t.openMenu();
    t.set({ ...base, memAvailableKB: base.memAvailableKB - 3 * GB });
    t.ctl.update();
    expect(t.counts.setContextMenu).toBe(1);
    t.closeMenu();
    expect(t.counts.setContextMenu).toBe(2);
    expect(t.menu()[0]!.label).toBe('RAM 45,0 Go · Swap 0,0 Go');
  });
  test('swap de 49 à 71 % : nouvelle couleur → redessin', () => {
    const t = setup({ ...base, swapFreeKB: 5.1 * GB });
    t.set({ ...base, swapFreeKB: 2.9 * GB });
    t.ctl.update();
    expect(t.counts.setImage).toBe(1);
    expect(t.images[0]![0]!.png.equals(t.images[1]![0]!.png)).toBe(false);
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
      'RAM 42,0 Go · Swap 0,0 Go', 'Pression 0 % · Charge 1,0', '—', 'Ouvrir Computer Watcher', 'Libérer de la mémoire…', '—', 'Quitter',
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
  test('lecture du système en erreur après coup : aucune exception, icône inchangée', () => {
    const t = setup();
    t.deps.readSystem = () => {
      throw new Error('EACCES');
    };
    expect(() => t.ctl.update()).not.toThrow();
    expect(t.counts.setImage).toBe(0);
    expect(t.ctl.active()).toBe(true);
  });
});

describe('menuKey', () => {
  test('pas de 0,5 Go, 0,5 de charge, 5 % de pression', () => {
    expect(menuKey(base)).toBe(menuKey({ ...base, memAvailableKB: base.memAvailableKB - 0.2 * GB, load1: 1.2, psiSome10: 2 }));
    expect(menuKey(base)).not.toBe(menuKey({ ...base, psiSome10: 6 }));
    expect(menuKey({ ...base, psiSome10: null })).not.toBe(menuKey(base));
  });
});

describe('statusNotifierAvailable', () => {
  const OWNER = ['--user', 'call', 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner', 's', 'org.kde.StatusNotifierWatcher'];
  const HOST = ['--user', 'get-property', 'org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher', 'org.kde.StatusNotifierWatcher', 'IsStatusNotifierHostRegistered'];
  const fake = (owner: string, host: string | null) =>
    vi.fn(async (_cmd: string, args: string[]) =>
      args.includes('NameHasOwner') ? { ok: true, stdout: owner } : host === null ? { ok: false, stdout: '' } : { ok: true, stdout: host },
    );
  test('watcher présent et hôte (zone de notification) enregistré → vrai', async () => {
    const run = fake('b true\n', 'b true\n');
    expect(await statusNotifierAvailable(run)).toBe(true);
    expect(run).toHaveBeenCalledWith('busctl', OWNER);
    expect(run).toHaveBeenCalledWith('busctl', HOST);
  });
  test('watcher présent, hôte absent (widget retiré, plasmashell arrêté) → faux', async () => {
    expect(await statusNotifierAvailable(fake('b true\n', 'b false\n'))).toBe(false);
    expect(await statusNotifierAvailable(fake('b true\n', null))).toBe(false);
  });
  test('watcher absent → faux, sans interroger la propriété', async () => {
    const run = fake('b false\n', 'b true\n');
    expect(await statusNotifierAvailable(run)).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });
  test('busctl absent ou bus inaccessible → faux', async () => {
    expect(await statusNotifierAvailable(async () => ({ ok: false, stdout: '' }))).toBe(false);
    expect(await statusNotifierAvailable(async () => Promise.reject(new Error('ENOENT')))).toBe(false);
  });
});

describe('confirmTray (vérification au moment de fermer)', () => {
  afterEach(() => void vi.useRealTimers());
  test('plafond de 1 s', () => {
    expect(TRAY_CHECK_MS).toBe(1000);
  });
  test('réponse oui → vrai ; non → faux ; erreur → faux', async () => {
    expect(await confirmTray(async () => true)).toBe(true);
    expect(await confirmTray(async () => false)).toBe(false);
    expect(await confirmTray(async () => Promise.reject(new Error('x')))).toBe(false);
  });
  test('réponse au-delà du plafond → faux (fermer quitte)', async () => {
    vi.useFakeTimers();
    const p = confirmTray(() => new Promise((r) => setTimeout(() => r(true), 1500)));
    await vi.advanceTimersByTimeAsync(1001);
    expect(await p).toBe(false);
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
