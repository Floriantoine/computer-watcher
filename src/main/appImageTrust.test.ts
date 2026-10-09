import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { hasControlChars, installedAppImage, installedElsewhere, ownAppImage } from './appImageTrust';

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

describe('ownAppImage', () => {
  test('APPDIR contient le binaire en cours, APPIMAGE est un fichier hors de APPDIR : accepté', () => {
    const l = layout();
    expect(ownAppImage({ APPIMAGE: l.img, APPDIR: l.appdir }, l.exe)).toBe(l.img);
  });
  test('environnement hérité d’une autre AppImage (.deb lancé depuis son terminal) : refusé', () => {
    const l = layout();
    const other = join(l.root, 'Editeur-1.2.3.AppImage');
    writeFileSync(other, 'x');
    const otherMount = join(l.root, '.mount_Editeur');
    mkdirSync(otherMount);
    expect(ownAppImage({ APPIMAGE: other, APPDIR: otherMount }, '/opt/proc-watch/proc-watch')).toBeNull();
    // APPIMAGE seul (sans APPDIR) : refusé
    expect(ownAppImage({ APPIMAGE: l.img }, l.exe)).toBeNull();
  });
  test('APPIMAGE absent, dossier, dans APPDIR ou chemin relatif : refusé', () => {
    const l = layout();
    expect(ownAppImage({ APPIMAGE: join(l.root, 'absent.AppImage'), APPDIR: l.appdir }, l.exe)).toBeNull();
    expect(ownAppImage({ APPIMAGE: l.root, APPDIR: l.appdir }, l.exe)).toBeNull();
    expect(ownAppImage({ APPIMAGE: l.exe, APPDIR: l.appdir }, l.exe)).toBeNull();
    expect(ownAppImage({ APPIMAGE: 'proc-watch.AppImage', APPDIR: l.appdir }, l.exe)).toBeNull();
  });
  test('lien symbolique vers un fichier dans APPDIR : refusé (chemin réel)', () => {
    const l = layout();
    const link = join(l.root, 'lien.AppImage');
    symlinkSync(l.exe, link);
    expect(ownAppImage({ APPIMAGE: link, APPDIR: l.appdir }, l.exe)).toBeNull();
  });
  test('caractères de contrôle dans le chemin : refusé', () => {
    const l = layout();
    const bad = join(l.root, 'proc-watch\nExecStartPre=x.AppImage');
    writeFileSync(bad, 'x');
    expect(ownAppImage({ APPIMAGE: bad, APPDIR: l.appdir }, l.exe)).toBeNull();
    expect(hasControlChars('a\x7fb')).toBe(true);
    expect(hasControlChars('/home/u/Applications/proc-watch.AppImage')).toBe(false);
  });
});

describe('copie installée (~/Applications/proc-watch.AppImage)', () => {
  test('chemin sans version, dans ~/Applications', () => {
    expect(installedAppImage('/home/u')).toBe('/home/u/Applications/proc-watch.AppImage');
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
