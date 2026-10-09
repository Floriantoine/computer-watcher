import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import * as trust from './appImageTrust';
import { hasControlChars, installedAppImage, installedElsewhere, legacyInstalledAppImage } from './appImageTrust';
import { realAppImage } from './realAppImage';
import { updateMode } from '../core/update';

/** Faux montage d'AppImage : APPDIR/proc-watch (binaire), et le fichier AppImage à côté. */
function layout() {
  const root = mkdtempSync(join(tmpdir(), 'pw-trust-'));
  const appdir = join(root, '.mount_proc-wABC');
  mkdirSync(appdir);
  const exe = join(appdir, 'proc-watch');
  writeFileSync(exe, '');
  const img = join(root, 'proc-watch-0.1.0-x86_64.AppImage');
  writeFileSync(img, 'appimage');
  return { root, appdir, exe, img };
}

describe('mises à jour : une seule source de vérité, realAppImage()', () => {
  test('ownAppImage n’existe plus (délégué à realAppImage)', () => {
    expect('ownAppImage' in trust).toBe(false);
  });
  test('faux APPDIR (dossier ordinaire qui contient le binaire) + faux APPIMAGE : refusé, l’updater ne passe jamais en mode « install »', () => {
    const l = layout();
    // ce montage factice était accepté par l'ancien ownAppImage ; APPDIR n'est pas un montage FUSE
    const img = realAppImage({ APPIMAGE: l.img, APPDIR: l.appdir });
    expect(img).toBeNull();
    expect(updateMode({ isPackaged: true, appImage: img, testFeed: null, installedElsewhere: false })).toBe('notify');
  });
  test('faux APPDIR déclaré FUSE mais APPIMAGE sans en-tête AppImage : refusé aussi', () => {
    const l = layout();
    const deps = { mountinfo: `1 2 0:9 / ${l.appdir} ro - fuse.proc-watch x ro`, realpath: (p: string) => (p === '/proc/self/exe' ? l.exe : p) };
    expect(realAppImage({ APPIMAGE: l.img, APPDIR: l.appdir }, deps)).toBeNull();
  });
  test('caractères de contrôle', () => {
    expect(hasControlChars('a\x7fb')).toBe(true);
    expect(hasControlChars('/home/u/Applications/proc-watch.AppImage')).toBe(false);
  });
});

describe('copie installée (~/Applications/computer-watcher.AppImage)', () => {
  test('chemin sans version, dans ~/Applications ; l’ancienne copie garde son nom', () => {
    expect(installedAppImage('/home/u')).toBe('/home/u/Applications/computer-watcher.AppImage');
    expect(legacyInstalledAppImage('/home/u')).toBe('/home/u/Applications/proc-watch.AppImage');
  });
  test('lancée depuis un autre fichier alors que la copie existe : « ailleurs »', () => {
    const l = layout();
    const home = join(l.root, 'home');
    mkdirSync(join(home, 'Applications'), { recursive: true });
    expect(installedElsewhere(l.img, home)).toBe(false); // pas de copie
    writeFileSync(installedAppImage(home), 'copie');
    expect(installedElsewhere(l.img, home)).toBe(true);
    expect(installedElsewhere(installedAppImage(home), home)).toBe(false);
    const link = join(l.root, 'raccourci.AppImage');
    symlinkSync(installedAppImage(home), link);
    expect(installedElsewhere(link, home)).toBe(false);
  });
});
