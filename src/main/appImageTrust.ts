// AppImage de CE processus : le runtime AppImage exporte APPIMAGE et APPDIR, que tous les processus enfants héritent
// (terminal d'un éditeur distribué en AppImage…). La variable seule n'est donc jamais crue : sinon une installation
// supprimerait l'AppImage d'une autre application (electron-updater fait `unlink($APPIMAGE)`).
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { APP_NAME, LEGACY_APP_NAME } from '../core/appName';

const CONTROL = /[\x00-\x1f\x7f]/;
/** Refusé avant d'écrire une unité systemd ou un raccourci (une fin de ligne y injecterait une directive). */
export const hasControlChars = (p: string): boolean => CONTROL.test(p);

// La vérification « cette AppImage est-elle bien la nôtre ? » est faite par realAppImage() (./realAppImage), seule source
// de vérité pour l'accueil, le menu, le service et les mises à jour.

/** Copie installée par « installer comme app » : nom sans version, qu'electron-updater remplace sur place. */
export const installedAppImage = (home: string): string => join(home, 'Applications', `${APP_NAME}.AppImage`);
/** Copie installée par une version d'avant le renommage (proc-watch) : migrée vers installedAppImage. */
export const legacyInstalledAppImage = (home: string): string => join(home, 'Applications', `${LEGACY_APP_NAME}.AppImage`);

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
