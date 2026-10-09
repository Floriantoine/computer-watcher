import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import { describe, expect, test } from 'vitest';
import { installTarget } from './appImageUpdate';

const COPY = '/home/u/Applications/proc-watch.AppImage';

describe('mise à jour de l’AppImage : la copie installée est remplacée, jamais l’original', () => {
  test('lancée depuis la copie : APPIMAGE (posé par le runtime) = la copie vérifiée → c’est elle qui est remplacée', () => {
    expect(installTarget({ APPIMAGE: COPY }, COPY)).toBe(COPY);
  });
  test('APPIMAGE différent de l’AppImage vérifiée par realAppImage (variable modifiée) : installation refusée', () => {
    expect(() => installTarget({ APPIMAGE: '/home/u/Téléchargements/proc-watch-1.0.0-x86_64.AppImage' }, COPY)).toThrow(/refusée/);
    expect(() => installTarget({}, COPY)).toThrow(/refusée/);
  });
  test('electron-updater remplace le fichier désigné par process.env.APPIMAGE, sur place quand son nom n’a pas de version', () => {
    // garde-fou de dépendance : si une version d'electron-updater change ce comportement, ce test le signale
    const src = readFileSync(createRequire(import.meta.url).resolve('electron-updater/out/AppImageUpdater.js'), 'utf8');
    expect(src).toMatch(/const appImageFile = process\.env\["APPIMAGE"\]/);
    expect(src).toMatch(/!\/\\d\+\\\.\\d\+\\\.\\d\+\/\.test\(existingBaseName\)\)\s*\{[^}]*destination = appImageFile/);
    expect(/\d+\.\d+\.\d+/.test(basename(COPY))).toBe(false); // « proc-watch.AppImage » : pas de version → écrasé sur place
  });
});
