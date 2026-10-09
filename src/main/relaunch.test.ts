import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'vitest';
import { relaunchDetached, restartCommand, sanitizeAppImageEnv } from './relaunch';

const M = '/tmp/.mount_proc-wOLD';
const COPY = '/home/u/Applications/proc-watch.AppImage';

describe('n-2 : environnement du processus principal en mode AppImage', () => {
  test('PATH, LD_LIBRARY_PATH, XDG_DATA_DIRS, GSETTINGS_SCHEMA_DIR réécrits sans le montage ; APPIMAGE et APPDIR gardés', () => {
    const env: NodeJS.ProcessEnv = {
      APPIMAGE: COPY, APPDIR: M, HOME: '/home/u',
      PATH: `${M}:${M}/usr/sbin:/usr/bin`, LD_LIBRARY_PATH: `${M}/usr/lib`,
      XDG_DATA_DIRS: `${M}/usr/share/::/usr/share/`, GSETTINGS_SCHEMA_DIR: `${M}/usr/share/glib-2.0/schemas`,
    };
    sanitizeAppImageEnv(env);
    expect(env).toEqual({ APPIMAGE: COPY, APPDIR: M, HOME: '/home/u', PATH: '/usr/bin', XDG_DATA_DIRS: '/usr/share/' });
  });
});

describe('n-3 : commande de relance', () => {
  test('environnement nettoyé + PROC_WATCH_RELAUNCH=1', () => {
    const c = restartCommand(COPY, { APPDIR: M, APPIMAGE: COPY, PATH: `${M}:/usr/bin`, HOME: '/h' });
    expect(c).toEqual({ cmd: COPY, args: [], env: { PATH: '/usr/bin', HOME: '/h', PROC_WATCH_RELAUNCH: '1' } });
  });
});

describe('n-1 : relance détachée, on ne quitte qu’au démarrage effectif', () => {
  const setup = (o: { usable?: boolean; throwOnSpawn?: boolean } = {}) => {
    const log: string[] = [];
    const child = Object.assign(new EventEmitter(), { unref: () => log.push('unref') });
    relaunchDetached({
      target: COPY,
      env: { HOME: '/h' },
      usable: () => o.usable ?? true,
      spawn: (cmd, args, opts) => {
        log.push(`spawn ${cmd} ${JSON.stringify(opts.env)} ${opts.detached}`);
        if (o.throwOnSpawn) throw new Error('EAGAIN');
        return child;
      },
      releaseLock: () => log.push('release'),
      reacquireLock: () => (log.push('reacquire'), true),
      onStarted: () => log.push('started'),
      onFailed: (m) => log.push(`failed ${m}`),
    });
    return { log, child };
  };
  test('événement « spawn » : alors seulement, on quitte', () => {
    const { log, child } = setup();
    expect(log).toEqual(['release', `spawn ${COPY} {"HOME":"/h","PROC_WATCH_RELAUNCH":"1"} true`]);
    child.emit('spawn');
    expect(log.slice(2)).toEqual(['unref', 'started']);
  });
  test('reproduction n-1 : « error » (EACCES) → verrou repris, échec signalé avec le chemin, jamais « started »', () => {
    const { log, child } = setup();
    child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }));
    expect(log.slice(2)).toEqual(['reacquire', `failed ${COPY} : spawn EACCES`]);
    expect(log).not.toContain('started');
  });
  test('spawn qui lève : même traitement', () => {
    const { log } = setup({ throwOnSpawn: true });
    expect(log.slice(-2)).toEqual(['reacquire', `failed ${COPY} : EAGAIN`]);
  });
  test('cible inutilisable (vide, pas une AppImage) : aucun spawn, verrou jamais relâché', () => {
    const { log } = setup({ usable: false });
    expect(log).toEqual([`failed ${COPY} : pas une AppImage utilisable`]);
  });
});
