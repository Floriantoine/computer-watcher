import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cleanEnv, systemBin } from '../core/childEnv';
import { pressureLevel } from '../core/pressure';
import type { SystemInfo } from '../core/types';
import { encodePng, iconKey, memPercent, ringPixels, TRAY_SIZE, trayMenuLabels } from './trayIcon';

/** Sous-ensemble de `Electron.Tray` utilisé ici (remplacé par un faux en test). */
export interface TrayLike {
  setImage(img: unknown): void;
  setToolTip(t: string): void;
  setContextMenu(m: unknown): void;
  on(ev: 'click', cb: () => void): void;
  destroy(): void;
}
export interface TrayMenuItem { label?: string; type?: 'separator'; enabled?: boolean; click?: () => void }
/** Une représentation de l'icône : PNG et facteur d'échelle (1x = 22 px, 2x = 44 px pour les écrans HiDPI). */
export interface IconRep { scaleFactor: number; png: Buffer }
export interface TrayDeps {
  createTray(image: unknown): TrayLike;
  image(reps: IconRep[]): unknown;
  menu(items: TrayMenuItem[]): unknown;
  /** Signale l'ouverture et la fermeture du menu, si la plateforme le permet (sinon jamais appelé). */
  watchMenu?(menu: unknown, onShow: () => void, onHide: () => void): void;
  readSystem(): SystemInfo;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
  onOpen(): void;
  onFree(): void;
  onQuit(): void;
}

/** Rythme de l'icône : 3 petits fichiers lus (meminfo, loadavg, pressure), aucun parcours de /proc. */
export const TRAY_EVERY_MS = 10_000;

/**
 * Clé de reconstruction du menu, plus grossière que ses libellés : RAM et swap au pas de 0,5 Go, charge au pas de 0,5,
 * pression au pas de 5 %. Le menu n'est refait (un LayoutUpdated dbusmenu) que si elle change.
 */
export function menuKey(s: SystemInfo): string {
  const half = (kb: number) => Math.round((Math.max(0, kb) / (1024 * 1024)) * 2);
  const psi = s.psiSome10 === null ? '-' : String(Math.round(s.psiSome10 / 5));
  return `${half(s.memTotalKB - s.memAvailableKB)}:${half(s.swapTotalKB - s.swapFreeKB)}:${Math.round(s.load1 * 2)}:${psi}`;
}

export interface TrayController {
  update(): void;
  stop(): void;
  /** Vrai si l'icône existe réellement (créée et pas encore détruite). */
  active(): boolean;
  stats(): { redraws: number; menus: number };
}

/**
 * Icône de la barre des tâches : redessinée seulement si sa clé (tranche de 5 % de RAM, niveau de pression) change,
 * menu refait seulement si `menuKey` change, et jamais pendant qu'il est ouvert (appliqué à sa fermeture).
 */
export function createTrayController(deps: TrayDeps): TrayController {
  let redraws = 0;
  let menus = 0;
  let key = '';
  let labelsKey = '';
  let tooltip = '';
  let tray: TrayLike | null = null;
  let timer: unknown = null;
  let stopped = false;
  let menuOpen = false;
  let pending: SystemInfo | null = null;

  const draw = (s: SystemInfo) => {
    const pct = memPercent(s);
    const level = pressureLevel(s);
    const next = iconKey(pct, level);
    if (next === key && tray) return;
    key = next;
    const img = deps.image([1, 2].map((scaleFactor) => ({ scaleFactor, png: encodePng(ringPixels(pct, level, TRAY_SIZE * scaleFactor), TRAY_SIZE * scaleFactor, TRAY_SIZE * scaleFactor) })));
    redraws++;
    if (tray) tray.setImage(img);
    else {
      tray = deps.createTray(img);
      tray.on('click', () => deps.onOpen());
    }
  };

  const buildMenu = (s: SystemInfo) => {
    const l = trayMenuLabels(s);
    menus++;
    const m = deps.menu([
      { label: l.mem, enabled: false },
      { label: l.pressure, enabled: false },
      { type: 'separator' },
      { label: 'Ouvrir proc-watch', click: () => deps.onOpen() },
      { label: 'Libérer de la mémoire…', click: () => deps.onFree() },
      { type: 'separator' },
      { label: 'Quitter', click: () => deps.onQuit() },
    ]);
    deps.watchMenu?.(
      m,
      () => void (menuOpen = true),
      () => {
        menuOpen = false;
        if (pending && tray && !stopped) {
          const p = pending;
          pending = null;
          buildMenu(p);
        }
      },
    );
    tray!.setContextMenu(m);
  };

  const describe = (s: SystemInfo) => {
    const l = trayMenuLabels(s);
    if (l.tooltip !== tooltip) {
      tooltip = l.tooltip;
      tray!.setToolTip(l.tooltip);
    }
    const k = menuKey(s);
    if (k === labelsKey) return;
    labelsKey = k;
    if (menuOpen) pending = s;
    else buildMenu(s);
  };

  const update = () => {
    if (stopped) return;
    let s: SystemInfo;
    try {
      s = deps.readSystem();
    } catch (e) {
      console.error('tray:', e);
      return;
    }
    draw(s);
    describe(s);
  };

  update();
  timer = deps.setInterval(update, TRAY_EVERY_MS);

  return {
    update,
    stop() {
      if (stopped) return;
      stopped = true;
      deps.clearInterval(timer);
      tray?.destroy();
      tray = null;
    },
    active: () => tray !== null,
    stats: () => ({ redraws, menus }),
  };
}

export type Run = (cmd: string, args: string[]) => Promise<{ ok: boolean; stdout: string }>;

export const defaultRun: Run = (cmd, args) =>
  new Promise((resolve) => {
    // outil système par chemin absolu, environnement sans le montage /tmp de l'AppImage (I-A)
    const bin = cmd.startsWith('/') ? cmd : systemBin(cmd, existsSync);
    if (!bin) return resolve({ ok: false, stdout: '' });
    execFile(bin, args, { timeout: 3000, env: cleanEnv(process.env) }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout) }));
  });

/**
 * Zone de notification réellement affichée : le watcher (org.kde.StatusNotifierWatcher, tenu par kded sous KDE) a un
 * propriétaire sur le bus de session **et** un hôte est enregistré (widget « Zone de notification » de plasmashell…).
 * Watcher sans hôte (widget retiré, plasmashell arrêté) → faux. Toute erreur → faux.
 */
export async function statusNotifierAvailable(run: Run): Promise<boolean> {
  try {
    const owner = await run('busctl', [
      '--user', 'call', 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner', 's', 'org.kde.StatusNotifierWatcher',
    ]);
    if (!owner.ok || owner.stdout.trim() !== 'b true') return false;
    const host = await run('busctl', [
      '--user', 'get-property', 'org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher', 'org.kde.StatusNotifierWatcher', 'IsStatusNotifierHostRegistered',
    ]);
    return host.ok && host.stdout.trim() === 'b true';
  } catch {
    return false;
  }
}

/** Plafond de la vérification faite au moment de fermer la fenêtre. */
export const TRAY_CHECK_MS = 1000;

/** `check` au plus `timeoutMs` : faux s'il répond non, lève ou tarde (fermer quitte alors au lieu de cacher). */
export function confirmTray(check: () => Promise<boolean>, timeoutMs = TRAY_CHECK_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    check().then(
      (ok) => {
        clearTimeout(t);
        resolve(ok === true);
      },
      () => {
        clearTimeout(t);
        resolve(false);
      },
    );
  });
}

/** Fermer la fenêtre la cache dans la barre seulement si l'icône est réellement affichée et que l'app ne quitte pas. */
export function closeAction(o: { closeToTray: boolean; trayActive: boolean; quitting: boolean }): 'hide' | 'close' {
  return o.closeToTray && o.trayActive && !o.quitting ? 'hide' : 'close';
}
