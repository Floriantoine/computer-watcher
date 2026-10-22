import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { describe, expect, test } from 'vitest';
import { LEGACY_UNIT_NAME, RECORDER_MEMORY_LOW_MB, UNIT_NAME, autoManageService, recorderSyncDisabled, ensureRecorderService, recorderAppImage, recorderExecArgs, recorderUnit, systemdQuote, unitPath, type Systemctl } from './recorderService';

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
  expect(unit).toContain('\nDescription=Computer Watcher recorder (historique des processus)\n');
  expect(unit).toContain('Environment=ELECTRON_RUN_AS_NODE=1\n');
  expect(unit).toContain('ExecStart="/opt/My App/pw" "/opt/My App/r.js"\n');
  expect(unit).toContain('Restart=always\n');
  expect(unit).toContain('WantedBy=default.target\n');
});

test('E : service réactif pendant un étouffement : session.slice, mémoire protégée, dernier choix des tueurs, jamais Nice=10', () => {
  const unit = recorderUnit(['/a', '/b']);
  const service = unit.slice(unit.indexOf('[Service]'), unit.indexOf('[Install]'));
  // session.slice : protégée par la « protection mémoire système » (bureau prioritaire) ; app.slice la partage avec Warp et Claude
  expect(service).toContain('\nSlice=session.slice\n');
  // ≈ 1,7 × le pic observé (RSS + swap, p99 191 Mo) : binaire, base et tas restent en RAM
  expect(service).toContain(`\nMemoryLow=${RECORDER_MEMORY_LOW_MB}M\n`);
  expect(RECORDER_MEMORY_LOW_MB).toBe(320);
  // plancher d'un service utilisateur : la valeur du gestionnaire (100) ; en dessous, systemd l'ignore
  expect(service).toContain('\nOOMScoreAdjust=100\n');
  expect(service).toContain('\nManagedOOMPreference=avoid\n');
  // tué par earlyoom (SIGTERM, sortie « propre ») : relancé quand même
  expect(service).toContain('\nRestart=always\nRestartSec=5\n');
  expect(unit).not.toMatch(/^Nice=/m);
  // jamais un plafond, un poids ni un gel posé sur le service
  expect(unit).not.toMatch(/^(MemoryMax|MemoryHigh|MemorySwapMax|CPUQuota|CPUWeight|IOWeight|Freeze)/m);
});

/** Unité telle qu'écrite par la v0.3.2 (et avant) pour ces arguments. */
const v032Unit = (args: string[]) => [
  '[Unit]', 'Description=Computer Watcher recorder (historique des processus)', 'StartLimitIntervalSec=300', 'StartLimitBurst=5', '',
  '[Service]', 'Environment=ELECTRON_RUN_AS_NODE=1', `ExecStart=${args.map(systemdQuote).join(' ')}`, 'Restart=on-failure', 'RestartSec=5', 'Nice=10', '',
  '[Install]', 'WantedBy=default.target', '',
].join('\n');

test('E : installation existante (unité de la v0.3.2) → la synchro du lancement suivant la réécrit et relance le service, une fois', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pw-e-')), 'systemd/user/computer-watcher-recorder.service');
  mkdirSync(dirname(path), { recursive: true });
  const args = recorderExecArgs({ appImage: '/home/u/Applications/computer-watcher.AppImage', execPath: '/x', appPath: '/y' });
  writeFileSync(path, v032Unit(args));
  const f = fake();
  // synchro au démarrage (index.ts : syncRecorder(false, …)) : unité existante, création non permise, pas de mise à jour d'app
  expect(await ensureRecorderService({ enabled: true, args, path, run: f.run, allowCreate: false })).toBe('updated');
  const unit = readFileSync(path, 'utf8');
  expect(unit).toBe(recorderUnit(args));
  expect(unit).toContain('Slice=session.slice\n');
  expect(f.calls).toEqual([['daemon-reload'], ['enable', UNIT_NAME], ['restart', UNIT_NAME]]);
  f.calls.length = 0;
  expect(await ensureRecorderService({ enabled: true, args, path, run: f.run, allowCreate: false })).toBe('unchanged');
  expect(f.calls).toEqual([['enable', '--now', UNIT_NAME]]);
});

test('unitPath', () => {
  expect(unitPath({ XDG_CONFIG_HOME: '/c' }, '/home/u')).toBe('/c/systemd/user/computer-watcher-recorder.service');
  expect(unitPath({}, '/home/u')).toBe('/home/u/.config/systemd/user/computer-watcher-recorder.service');
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
  const path = join(mkdtempSync(join(tmpdir(), 'pw-s-')), 'systemd/user/computer-watcher-recorder.service');
  const f = fake();
  expect(await ensureRecorderService({ enabled: true, args: ['/a', '/b'], path, run: f.run })).toBe('installed');
  expect(readFileSync(path, 'utf8')).toBe(recorderUnit(['/a', '/b']));
  expect(f.calls).toEqual([['daemon-reload'], ['enable', '--now', 'computer-watcher-recorder.service']]);

  f.calls.length = 0;
  expect(await ensureRecorderService({ enabled: true, args: ['/a', '/b'], path, run: f.run })).toBe('unchanged');
  expect(f.calls).toEqual([['enable', '--now', 'computer-watcher-recorder.service']]);

  f.calls.length = 0;
  expect(await ensureRecorderService({ enabled: true, args: ['/moved', '/b'], path, run: f.run })).toBe('updated');
  expect(f.calls).toEqual([['daemon-reload'], ['enable', 'computer-watcher-recorder.service'], ['restart', 'computer-watcher-recorder.service']]);

  f.calls.length = 0;
  expect(await ensureRecorderService({ enabled: false, args: ['/moved', '/b'], path, run: f.run })).toBe('removed');
  expect(existsSync(path)).toBe(false);
  expect(f.calls).toEqual([['disable', '--now', 'computer-watcher-recorder.service'], ['daemon-reload']]);

  f.calls.length = 0;
  expect(await ensureRecorderService({ enabled: false, args: [], path, run: f.run })).toBe('absent');
  expect(f.calls).toEqual([]);
});

test('ensure sans création (dev) : rien si l\'unité n\'existe pas ; mise à jour ou retrait si elle existe', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pw-s-')), 'systemd/user/computer-watcher-recorder.service');
  const f = fake();
  expect(await ensureRecorderService({ enabled: true, args: ['/a'], path, run: f.run, allowCreate: false })).toBe('absent');
  expect(existsSync(path)).toBe(false);
  expect(f.calls).toEqual([]);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, recorderUnit(['/old']));
  expect(await ensureRecorderService({ enabled: true, args: ['/new'], path, run: f.run, allowCreate: false })).toBe('updated');
  expect(readFileSync(path, 'utf8')).toBe(recorderUnit(['/new']));
  expect(f.calls).toEqual([['daemon-reload'], ['enable', 'computer-watcher-recorder.service'], ['restart', 'computer-watcher-recorder.service']]);

  f.calls.length = 0;
  expect(await ensureRecorderService({ enabled: false, args: ['/new'], path, run: f.run, allowCreate: false })).toBe('removed');
  expect(existsSync(path)).toBe(false);
  expect(f.calls).toEqual([['disable', '--now', 'computer-watcher-recorder.service'], ['daemon-reload']]);
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
  const path = join(dir, 'computer-watcher-recorder.service');
  const calls: string[][] = [];
  const run = async (a: string[]) => {
    calls.push(a);
    return { ok: true, stdout: '' };
  };
  await ensureRecorderService({ enabled: true, args: ['/a'], path, run });
  calls.length = 0;
  expect(await ensureRecorderService({ enabled: true, args: ['/a'], path, run, restart: true })).toBe('restarted');
  expect(calls).toEqual([['enable', '--now', 'computer-watcher-recorder.service'], ['restart', 'computer-watcher-recorder.service']]);
  // unité absente en mode dev : restart ne crée rien
  rmSync(path);
  calls.length = 0;
  expect(await ensureRecorderService({ enabled: true, args: ['/a'], path, run, restart: true, allowCreate: false })).toBe('absent');
  expect(calls).toEqual([]);
});

test('caractère de contrôle dans un argument (chemin d’AppImage) : refusé, unité jamais écrite', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pw-ctl-')), 'computer-watcher-recorder.service');
  const f = fake();
  expect(() => recorderUnit(['/home/u/a\nExecStartPre=/bin/x.AppImage'])).toThrow();
  await expect(ensureRecorderService({ enabled: true, args: ['/home/u/a\rb'], path, run: f.run })).rejects.toThrow();
  expect(existsSync(path)).toBe(false);
  expect(f.calls).toEqual([]);
});

describe('N1 : le service pointe vers la copie installée quand elle existe', () => {
  const copy = '/home/u/Applications/computer-watcher.AppImage';
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
    const path = join(dir, 'computer-watcher-recorder.service');
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
    const copy = join(dir, 'computer-watcher.AppImage');
    const own = '/home/u/dl/proc-watch-1.0.0-x86_64.AppImage';
    writeFileSync(copy, '');
    expect(recorderAppImage(own, copy)).toBe(own);
    writeFileSync(copy, 'texte');
    expect(recorderAppImage(own, copy)).toBe(own);
    writeFileSync(copy, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 0x02]), Buffer.from('ok')]));
    expect(recorderAppImage(own, copy)).toBe(copy);
  });
});

test('M-2 : unité sous ~/.config si XDG_CONFIG_HOME est relatif', () => {
  expect(unitPath({ XDG_CONFIG_HOME: 'rel' }, '/home/u')).toBe('/home/u/.config/systemd/user/computer-watcher-recorder.service');
});

test('renommage : nom de l’unité, ancien nom, et chemin d’une unité nommée', () => {
  expect(UNIT_NAME).toBe('computer-watcher-recorder.service');
  expect(LEGACY_UNIT_NAME).toBe('proc-watch-recorder.service');
  expect(unitPath({}, '/home/u', LEGACY_UNIT_NAME)).toBe('/home/u/.config/systemd/user/proc-watch-recorder.service');
});
