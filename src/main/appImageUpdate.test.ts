import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import { describe, expect, test } from 'vitest';
import { TEST_UPDATE_CONFIG, installAndRestart, installTarget } from './appImageUpdate';
import { InstallError } from './updater';

const COPY = '/home/u/Applications/computer-watcher.AppImage';

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
    expect(/\d+\.\d+\.\d+/.test(basename(COPY))).toBe(false); // « computer-watcher.AppImage » : pas de version → écrasé sur place
  });
});

describe('I-C : après l’installation, la nouvelle version est relancée par proc-watch, jamais par electron-updater', () => {
  const M = '/tmp/.mount_proc-wOLD';
  const fake = (ok: boolean, renamed?: string) => {
    const calls: unknown[][] = [];
    const listeners = new Map<string, (p: string) => void>();
    return {
      calls,
      u: {
        install: (silent: boolean, force: boolean) => {
          calls.push([silent, force]);
          if (renamed) listeners.get('appimage-filename-updated')?.(renamed);
          return ok;
        },
        on: (ev: string, cb: (p: string) => void) => void listeners.set(ev, cb),
      },
    };
  };
  test('install(silencieux, sans relance) puis relance par nous de la copie mise à jour', () => {
    const f = fake(true);
    const restarted: string[] = [];
    installAndRestart(f.u, { appImage: COPY, takeError: () => null, pendingFile: () => '/c/pending.AppImage', restart: (t) => restarted.push(t) });
    expect(f.calls).toEqual([[true, false]]);
    expect(restarted).toEqual([COPY]);
  });
  test('nom changé par electron-updater (AppImage versionnée) : la relance vise le nouveau fichier', () => {
    const f = fake(true, '/home/u/dl/proc-watch-0.1.1-x86_64.AppImage');
    const restarted: string[] = [];
    installAndRestart(f.u, { appImage: '/home/u/dl/proc-watch-0.1.0-x86_64.AppImage', takeError: () => null, pendingFile: () => null, restart: (t) => restarted.push(t) });
    expect(restarted).toEqual(['/home/u/dl/proc-watch-0.1.1-x86_64.AppImage']);
  });
  test('échec (erreur ou install refusée) : InstallError, aucune relance', () => {
    const restarted: string[] = [];
    expect(() => installAndRestart(fake(true).u, { appImage: COPY, takeError: () => new Error('lecture seule'), pendingFile: () => null, restart: (t) => restarted.push(t) })).toThrow(InstallError);
    expect(() => installAndRestart(fake(false).u, { appImage: COPY, takeError: () => null, pendingFile: () => null, restart: (t) => restarted.push(t) })).toThrow(InstallError);
    expect(restarted).toEqual([]);
  });
  test('échec : « Réessayer » reste possible (verrou interne d’electron-updater relâché)', () => {
    let reset = 0;
    expect(() => installAndRestart(fake(false).u, { appImage: COPY, takeError: () => null, pendingFile: () => null, restart: () => {}, onFailure: () => reset++ })).toThrow(InstallError);
    expect(reset).toBe(1);
  });
});

test('renommage : flux de test, cache de l’updater au nouveau nom', () => {
  expect(TEST_UPDATE_CONFIG).toBe('updaterCacheDirName: computer-watcher-updater-test\n');
});
