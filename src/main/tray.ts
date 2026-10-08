import { execFile } from 'node:child_process';
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
export interface TrayDeps {
  createTray(image: unknown): TrayLike;
  image(png: Buffer): unknown;
  menu(items: TrayMenuItem[]): unknown;
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
 * Icône de la barre des tâches : redessinée seulement si sa clé (tranche de 5 % de RAM, niveau de pression) change,
 * menu refait seulement si ses libellés changent.
 */
export function createTrayController(deps: TrayDeps): { update(): void; stop(): void; stats(): { redraws: number; menus: number } } {
  let redraws = 0;
  let menus = 0;
  let key = '';
  let labelsKey = '';
  let tooltip = '';
  let tray: TrayLike | null = null;
  let timer: unknown = null;

  const draw = (s: SystemInfo) => {
    const pct = memPercent(s);
    const level = pressureLevel(s);
    const next = iconKey(pct, level);
    if (next === key && tray) return;
    key = next;
    const img = deps.image(encodePng(ringPixels(pct, level), TRAY_SIZE, TRAY_SIZE));
    redraws++;
    if (tray) tray.setImage(img);
    else {
      tray = deps.createTray(img);
      tray.on('click', () => deps.onOpen());
    }
  };

  const describe = (s: SystemInfo) => {
    const l = trayMenuLabels(s);
    if (l.tooltip !== tooltip) {
      tooltip = l.tooltip;
      tray!.setToolTip(l.tooltip);
    }
    const k = `${l.mem}\n${l.pressure}`;
    if (k === labelsKey) return;
    labelsKey = k;
    menus++;
    tray!.setContextMenu(
      deps.menu([
        { label: l.mem, enabled: false },
        { label: l.pressure, enabled: false },
        { type: 'separator' },
        { label: 'Ouvrir proc-watch', click: () => deps.onOpen() },
        { label: 'Libérer de la mémoire…', click: () => deps.onFree() },
        { type: 'separator' },
        { label: 'Quitter', click: () => deps.onQuit() },
      ]),
    );
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

  let stopped = false;
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
    stats: () => ({ redraws, menus }),
  };
}

export type Run = (cmd: string, args: string[]) => Promise<{ ok: boolean; stdout: string }>;

export const defaultRun: Run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000 }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout) }));
  });

/** org.kde.StatusNotifierWatcher a-t-il un propriétaire sur le bus de session ? Toute erreur → false. */
export async function statusNotifierAvailable(run: Run): Promise<boolean> {
  try {
    const r = await run('busctl', [
      '--user', 'call', 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner', 's', 'org.kde.StatusNotifierWatcher',
    ]);
    return r.ok && r.stdout.trim() === 'b true';
  } catch {
    return false;
  }
}

/** Fermer la fenêtre la cache dans la barre seulement si l'icône est réellement affichée et que l'app ne quitte pas. */
export function closeAction(o: { closeToTray: boolean; trayActive: boolean; quitting: boolean }): 'hide' | 'close' {
  return o.closeToTray && o.trayActive && !o.quitting ? 'hide' : 'close';
}
