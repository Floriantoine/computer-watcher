import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { describe, expect, test } from 'vitest';
import { autoManageService, recorderSyncDisabled, ensureRecorderService, recorderAppImage, recorderExecArgs, recorderUnit, systemdQuote, unitPath, type Systemctl } from './recorderService';

test('systemdQuote échappe \\ " $ % et entoure de guillemets', () => {
  expect(systemdQuote('/opt/My App/p%w$x"y\\z')).toBe('"/opt/My App/p%%w$$x\\"y\\\\z"');
});

test('recorderExecArgs : AppImage → require via APPDIR', () => {
  expect(recorderExecArgs({ appImage: '/home/u/Apps/pw.AppImage', execPath: '/tmp/.mount/pw', appPath: '/tmp/.mount/resources/app.asar' })).toEqual([
    '/home/u/Apps/pw.AppImage',
    '-e',
    "require(process.env.APPDIR + '/resources/app.asar/out/main/recorder.js')",
  ]);
});

test('recorderExecArgs : .deb / dev → binaire + script', () => {
  expect(recorderExecArgs({ execPath: '/opt/proc-watch/proc-watch', appPath: '/opt/proc-watch/resources/app.asar' })).toEqual([
    '/opt/proc-watch/proc-watch',
    '/opt/proc-watch/resources/app.asar/out/main/recorder.js',
  ]);
});

test('recorderUnit', () => {
  const unit = recorderUnit(['/opt/My App/pw', '/opt/My App/r.js']);
  expect(unit).toContain('Environment=ELECTRON_RUN_AS_NODE=1\n');
  expect(unit).toContain('ExecStart="/opt/My App/pw" "/opt/My App/r.js"\n');
  expect(unit).toContain('Restart=on-failure\n');
  expect(unit).toContain('WantedBy=default.target\n');
});

test('unitPath', () => {
  expect(unitPath({ XDG_CONFIG_HOME: '/c' }, '/home/u')).toBe('/c/systemd/user/proc-watch-recorder.service');
  expect(unitPath({}, '/home/u')).toBe('/home/u/.config/systemd/user/proc-watch-recorder.service');
});

function fake() {
  const calls: string[][] = [];
  const run: Systemctl = async (args) => {
    calls.push(args);
    return { ok: true, stdout: '' };
  };
  return { calls, run };
}

test('ensure : installe, puis inchangé, puis mis à jour, puis retiré', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pw-s-')), 'systemd/user/proc-watch-recorder.service');
  const f = fake();
  expect(await ensureRecorderService({ enabled: true, args: ['/a', '/b'], path, run: f.run })).toBe('installed');
  expect(readFileSync(path, 'utf8')).toBe(recorderUnit(['/a', '/b']));
  expect(f.calls).toEqual([['daemon-reload'], ['enable', '--now', 'proc-watch-recorder.service']]);

  f.calls.length = 0;
  expect(await ensureRecorderService({ enabled: true, args: ['/a', '/b'], path, run: f.run })).toBe('unchanged');
  expect(f.calls).toEqual([['enable', '--now', 'proc-watch-recorder.service']]);

  f.calls.length = 0;
  expect(await ensureRecorderService({ enabled: true, args: ['/moved', '/b'], path, run: f.run })).toBe('updated');
  expect(f.calls).toEqual([['daemon-reload'], ['enable', 'proc-watch-recorder.service'], ['restart', 'proc-watch-recorder.service']]);

  f.calls.length = 0;
  expect(await ensureRecorderService({ enabled: false, args: ['/moved', '/b'], path, run: f.run })).toBe('removed');
  expect(existsSync(path)).toBe(false);
  expect(f.calls).toEqual([['disable', '--now', 'proc-watch-recorder.service'], ['daemon-reload']]);

  f.calls.length = 0;
  expect(await ensureRecorderService({ enabled: false, args: [], path, run: f.run })).toBe('absent');
  expect(f.calls).toEqual([]);
});

test('ensure sans création (dev) : rien si l\'unité n\'existe pas ; mise à jour ou retrait si elle existe', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pw-s-')), 'systemd/user/proc-watch-recorder.service');
  const f = fake();
  expect(await ensureRecorderService({ enabled: true, args: ['/a'], path, run: f.run, allowCreate: false })).toBe('absent');
  expect(existsSync(path)).toBe(false);
  expect(f.calls).toEqual([]);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, recorderUnit(['/old']));
  expect(await ensureRecorderService({ enabled: true, args: ['/new'], path, run: f.run, allowCreate: false })).toBe('updated');
  expect(readFileSync(path, 'utf8')).toBe(recorderUnit(['/new']));
  expect(f.calls).toEqual([['daemon-reload'], ['enable', 'proc-watch-recorder.service'], ['restart', 'proc-watch-recorder.service']]);

  f.calls.length = 0;
  expect(await ensureRecorderService({ enabled: false, args: ['/new'], path, run: f.run, allowCreate: false })).toBe('removed');
  expect(existsSync(path)).toBe(false);
  expect(f.calls).toEqual([['disable', '--now', 'proc-watch-recorder.service'], ['daemon-reload']]);
});

test('recorderUnit : redémarrages limités (pas de boucle infinie si le binaire disparaît)', () => {
  const unit = recorderUnit(['/a', '/b']);
  const unitSection = unit.slice(unit.indexOf('[Unit]'), unit.indexOf('[Service]'));
  expect(unitSection).toContain('StartLimitIntervalSec=300\n');
  expect(unitSection).toContain('StartLimitBurst=5\n');
});

test('autoManageService : version installée, ou clone de dev avec PROC_WATCH_RECORDER_DEV=1', () => {
  expect(autoManageService(true, {})).toBe(true);
  expect(autoManageService(false, {})).toBe(false);
  expect(autoManageService(false, { PROC_WATCH_RECORDER_DEV: '1' })).toBe(true);
  expect(autoManageService(false, { PROC_WATCH_RECORDER_DEV: '0' })).toBe(false);
});

test('PROC_WATCH_NO_RECORDER_SYNC=1 : l\'app ne touche jamais au service (mesures, tests)', () => {
  expect(recorderSyncDisabled({ PROC_WATCH_NO_RECORDER_SYNC: '1' })).toBe(true);
  expect(recorderSyncDisabled({})).toBe(false);
  expect(recorderSyncDisabled({ PROC_WATCH_NO_RECORDER_SYNC: '0' })).toBe(false);
});

test('restart : unité inchangée mais nouvelle version de l’app → le service est relancé (nouveau code)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'procwatch-unit-restart-'));
  const path = join(dir, 'proc-watch-recorder.service');
  const calls: string[][] = [];
  const run = async (a: string[]) => {
    calls.push(a);
    return { ok: true, stdout: '' };
  };
  await ensureRecorderService({ enabled: true, args: ['/a'], path, run });
  calls.length = 0;
  expect(await ensureRecorderService({ enabled: true, args: ['/a'], path, run, restart: true })).toBe('restarted');
  expect(calls).toEqual([['enable', '--now', 'proc-watch-recorder.service'], ['restart', 'proc-watch-recorder.service']]);
  // unité absente en mode dev : restart ne crée rien
  rmSync(path);
  calls.length = 0;
  expect(await ensureRecorderService({ enabled: true, args: ['/a'], path, run, restart: true, allowCreate: false })).toBe('absent');
  expect(calls).toEqual([]);
});

test('caractère de contrôle dans un argument (chemin d’AppImage) : refusé, unité jamais écrite', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pw-ctl-')), 'proc-watch-recorder.service');
  const f = fake();
  expect(() => recorderUnit(['/home/u/a\nExecStartPre=/bin/x.AppImage'])).toThrow();
  await expect(ensureRecorderService({ enabled: true, args: ['/home/u/a\rb'], path, run: f.run })).rejects.toThrow();
  expect(existsSync(path)).toBe(false);
  expect(f.calls).toEqual([]);
});

describe('N1 : le service pointe vers la copie installée quand elle existe', () => {
  const copy = '/home/u/Applications/proc-watch.AppImage';
  const dl = '/home/u/Téléchargements/proc-watch-1.0.0-x86_64.AppImage';
  test('lancée depuis l’original téléchargé, copie présente → la copie, jamais l’original', () => {
    expect(recorderAppImage(dl, copy, (p) => p === copy)).toBe(copy);
    const args = recorderExecArgs({ appImage: recorderAppImage(dl, copy, (p) => p === copy) ?? undefined, execPath: '/x', appPath: '/y' });
    expect(args[0]).toBe(copy);
    expect(recorderUnit(args)).toContain(`ExecStart="${copy}"`);
    expect(recorderUnit(args)).not.toContain(dl);
  });
  test('lancée depuis la copie → la copie', () => {
    expect(recorderAppImage(copy, copy, () => true)).toBe(copy);
  });
  test('pas de copie → l’AppImage lancée ; pas une AppImage (.deb, dev) → null (binaire lancé)', () => {
    expect(recorderAppImage(dl, copy, () => false)).toBe(dl);
    expect(recorderAppImage(null, copy, () => true)).toBeNull();
  });
  test('resynchro au démarrage depuis l’original : l’unité qui vise la copie n’est jamais réécrite vers l’original', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pw-n1-'));
    const path = join(dir, 'proc-watch-recorder.service');
    const run: Systemctl = async () => ({ ok: true, stdout: '' });
    const args = () => recorderExecArgs({ appImage: recorderAppImage(dl, copy, (p) => p === copy) ?? undefined, execPath: '/x', appPath: '/y' });
    expect(await ensureRecorderService({ enabled: true, args: args(), path, run })).toBe('installed');
    expect(await ensureRecorderService({ enabled: true, args: args(), path, run })).toBe('unchanged');
    expect(readFileSync(path, 'utf8')).toContain(copy);
    expect(readFileSync(path, 'utf8')).not.toContain(dl);
  });
});

describe('R2 : copie installée inutilisable → l’AppImage lancée', () => {
  test('fichier vide laissé par une mise à jour ratée, ou sans en-tête AppImage : jamais choisi', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pw-r2-'));
    const copy = join(dir, 'proc-watch.AppImage');
    const own = '/home/u/dl/proc-watch-1.0.0-x86_64.AppImage';
    writeFileSync(copy, '');
    expect(recorderAppImage(own, copy)).toBe(own);
    writeFileSync(copy, 'texte');
    expect(recorderAppImage(own, copy)).toBe(own);
    writeFileSync(copy, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 0x02]), Buffer.from('ok')]));
    expect(recorderAppImage(own, copy)).toBe(copy);
  });
});
