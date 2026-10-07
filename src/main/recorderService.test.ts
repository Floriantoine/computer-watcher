import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { expect, test } from 'vitest';
import { autoManageService, ensureRecorderService, recorderExecArgs, recorderUnit, systemdQuote, unitPath, type Systemctl } from './recorderService';

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
