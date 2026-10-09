// AppImage de CE processus : le runtime AppImage exporte APPIMAGE et APPDIR, que tous les processus enfants héritent
// (terminal d'un éditeur distribué en AppImage…). La variable seule n'est donc jamais crue : sinon une installation
// supprimerait l'AppImage d'une autre application (electron-updater fait `unlink($APPIMAGE)`).
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const CONTROL = /[\x00-\x1f\x7f]/;
/** Refusé avant d'écrire une unité systemd ou un raccourci (une fin de ligne y injecterait une directive). */
export const hasControlChars = (p: string): boolean => CONTROL.test(p);

const inside = (child: string, dir: string) => child === dir || child.startsWith(dir.endsWith('/') ? dir : `${dir}/`);

/**
 * APPIMAGE retenu seulement si : APPDIR est défini et le binaire en cours (`execPath`, chemin réel) est dans APPDIR, et
 * APPIMAGE est un chemin absolu vers un fichier ordinaire existant, hors de APPDIR (chemin réel), sans caractère de contrôle.
 */
export function ownAppImage(env: NodeJS.ProcessEnv, execPath: string): string | null {
  const img = env.APPIMAGE;
  const dir = env.APPDIR;
  if (!img || !dir || !isAbsolute(img) || !isAbsolute(dir) || hasControlChars(img)) return null;
  try {
    const realDir = realpathSync(dir);
    if (!inside(realpathSync(execPath), realDir)) return null;
    const realImg = realpathSync(img);
    if (inside(realImg, realDir) || hasControlChars(realImg) || !statSync(realImg).isFile()) return null;
    return img;
  } catch {
    return null;
  }
}

/** Copie installée par « installer comme app » : nom sans version, qu'electron-updater remplace sur place. */
export const installedAppImage = (home: string): string => join(home, 'Applications', 'proc-watch.AppImage');

/** Une copie installée existe et ce n'est pas elle qui tourne : on ne met pas à jour l'original téléchargé. */
export function installedElsewhere(appImage: string, home: string): boolean {
  let copy: string;
  try {
    copy = realpathSync(installedAppImage(home));
  } catch {
    return false;
  }
  try {
    return realpathSync(appImage) !== copy;
  } catch {
    return true;
  }
}
