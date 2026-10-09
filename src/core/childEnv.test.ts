import { describe, expect, test } from 'vitest';
import { cleanEnv, systemBin } from './childEnv';
import { xdgHome } from './paths';

const M = '/tmp/.mount_proc-wAbC12';
/** Environnement posé par l'AppRun d'electron-builder (appImageUtil.js). */
const apprun = {
  HOME: '/home/u',
  APPIMAGE: '/home/u/Applications/proc-watch.AppImage',
  APPDIR: M,
  ARGV0: 'proc-watch.AppImage',
  OWD: '/home/u',
  PATH: `${M}:${M}/usr/sbin:/usr/local/bin:/usr/bin`,
  XDG_DATA_DIRS: `${M}/usr/share/::/usr/share/gnome:/usr/local/share/:/usr/share/`,
  LD_LIBRARY_PATH: `${M}/usr/lib`,
  GSETTINGS_SCHEMA_DIR: `${M}/usr/share/glib-2.0/schemas`,
  AUTRE: `/tmp/.mount_proc-wOLD/x:/opt/y`,
  LANG: 'fr_FR.UTF-8',
};

describe('I-A : environnement transmis aux processus lancés par l’app (aucune entrée sous le montage /tmp)', () => {
  test('reproduction : environnement « AppRun » → plus rien sous /tmp/.mount_ ni APPDIR', () => {
    const e = cleanEnv(apprun);
    expect(JSON.stringify(e)).not.toContain('/tmp/.mount_');
    expect(e.PATH).toBe('/usr/local/bin:/usr/bin');
    expect(e.XDG_DATA_DIRS).toBe('/usr/share/gnome:/usr/local/share/:/usr/share/');
    expect('LD_LIBRARY_PATH' in e).toBe(false);
    expect('GSETTINGS_SCHEMA_DIR' in e).toBe(false);
    expect(e.AUTRE).toBe('/opt/y');
    for (const k of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD']) expect(k in e).toBe(false);
    expect(e.HOME).toBe('/home/u');
    expect(e.LANG).toBe('fr_FR.UTF-8');
  });
  test('APPDIR hors de /tmp (autre runtime) : ses entrées sont retirées aussi', () => {
    const e = cleanEnv({ APPDIR: '/run/user/1000/app', PATH: '/run/user/1000/app/usr/bin:/usr/bin' });
    expect(e.PATH).toBe('/usr/bin');
  });
  test('m-a : liste séparée par des espaces (LD_PRELOAD) ou valeur composée qui contient encore le montage : variable retirée', () => {
    const e = cleanEnv({ APPDIR: M, LD_PRELOAD: `/usr/lib/libok.so ${M}/libx.so`, X: `a=${M}/b`, Y: '/run/app/x', OK: '/usr/lib/libok.so' });
    expect('LD_PRELOAD' in e).toBe(false);
    expect('X' in e).toBe(false);
    expect(e.OK).toBe('/usr/lib/libok.so');
    expect(cleanEnv({ APPDIR: '/run/app', Y: 'k=/run/app/x' })).toEqual({});
  });
  test('rien sous le montage : inchangé (sauf variables du runtime)', () => {
    expect(cleanEnv({ PATH: '/usr/bin:/bin', HOME: '/h' })).toEqual({ PATH: '/usr/bin:/bin', HOME: '/h' });
  });
});

describe('outils système par chemin absolu', () => {
  test('/usr/bin d’abord, puis /bin, sinon null', () => {
    expect(systemBin('rm', (p) => p === '/usr/bin/rm')).toBe('/usr/bin/rm');
    expect(systemBin('rm', (p) => p === '/bin/rm')).toBe('/bin/rm');
    expect(systemBin('rm', () => false)).toBeNull();
    expect(() => systemBin('../x', () => true)).toThrow();
  });
});

describe('M-2 : variables XDG non absolues ignorées (spécification XDG)', () => {
  test('absolue : retenue ; relative ou vide : valeur par défaut', () => {
    expect(xdgHome({ XDG_CONFIG_HOME: '/c' }, 'XDG_CONFIG_HOME', '/h/.config')).toBe('/c');
    expect(xdgHome({ XDG_CONFIG_HOME: 'rel/cfg' }, 'XDG_CONFIG_HOME', '/h/.config')).toBe('/h/.config');
    expect(xdgHome({ XDG_CONFIG_HOME: '' }, 'XDG_CONFIG_HOME', '/h/.config')).toBe('/h/.config');
    expect(xdgHome({}, 'XDG_CONFIG_HOME', '/h/.config')).toBe('/h/.config');
  });
});
