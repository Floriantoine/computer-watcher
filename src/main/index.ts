import { app, BrowserWindow, ipcMain } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CpuTracker } from '../core/collector/cpuTracker';
import { readProcesses } from '../core/collector/readProcesses';
import { readSystem } from '../core/collector/readSystem';
import { configDir, loadConfig, saveConfig, validateConfig } from '../core/config';
import { buildGroups } from '../core/grouping/buildGroups';
import { createProjectRootCache } from '../core/grouping/projectRootCache';
import { planKill, sendSignals } from '../core/kill';
import { compileProtection } from '../core/protection';
import { formatAppEvent } from '../core/history/events';
import { appEventsPath, dataDir } from '../core/paths';
import type { ConfigState, KillResult, KillTarget, RecorderState, Snapshot } from '../core/types';
import { installDesktopEntry } from './desktopEntry';
import { clearHistory, createHistoryReader } from './history';
import { isGroupKeys, isRange, isTopOptions, recorderState as computeRecorderState } from './historyIpc';
import { defaultSystemctl, ensureRecorderService, recorderExecArgs, systemctlAvailable, unitPath } from './recorderService';

const POLL_MS = 2000;
const dir = configDir();
const loaded = loadConfig(dir);
let config = loaded.config;
let warning = loaded.warning;
let protection = compileProtection(config.protected);
const tracker = new CpuTracker();
const uid = process.getuid!();

const projectRootOf = createProjectRootCache();

const data = dataDir();
const history = createHistoryReader(data, () => config.recorder);
let systemdOk = false;

const execArgs = () => recorderExecArgs({ appImage: process.env.APPIMAGE, execPath: process.execPath, appPath: app.getAppPath() });

async function doSync(): Promise<void> {
  systemdOk = await systemctlAvailable(defaultSystemctl);
  if (!systemdOk) return;
  try {
    await ensureRecorderService({ enabled: config.recorder.enabled, args: execArgs(), path: unitPath(), run: defaultSystemctl });
  } catch (e) {
    console.error('recorder service:', e);
  }
}

let syncing: Promise<void> = Promise.resolve();
/** Sérialise les synchronisations pour éviter des appels systemctl concurrents. */
function syncRecorder(): Promise<void> {
  syncing = syncing.then(doSync, doSync);
  return syncing;
}

const recorderState = (): RecorderState =>
  computeRecorderState({ available: systemdOk, enabled: config.recorder.enabled, intervalSec: config.recorder.intervalSec, status: history.status(), now: Date.now() });

function takeSnapshot(): Snapshot {
  const procs = tracker.update(readProcesses(), Date.now());
  const groups = buildGroups(procs, {
    home: homedir(),
    currentUid: uid,
    isProtected: protection.isProtected,
    othersThreshold: config.othersThreshold,
    projectRootOf,
  });
  return { takenAt: Date.now(), currentUid: uid, system: readSystem(), groups };
}

const configState = (): ConfigState => ({ config, warning, invalid: protection.invalid });

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'proc-watch',
    backgroundColor: '#0b0c10',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  const push = () => {
    if (win.isDestroyed()) return;
    try {
      win.webContents.send('snapshot', takeSnapshot());
    } catch (err) {
      console.error('snapshot failed:', err);
    }
  };
  win.webContents.on('did-finish-load', push);
  const timer = setInterval(push, POLL_MS);
  win.on('closed', () => clearInterval(timer));
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(__dirname, '../renderer/index.html'));
}

const isKillTarget = (t: unknown): t is KillTarget =>
  typeof t === 'object' && t !== null && Number.isInteger((t as KillTarget).pid) && Number.isInteger((t as KillTarget).startTicks);

ipcMain.handle('kill', (_e, targets: unknown, signal: unknown): KillResult[] => {
  if (!Array.isArray(targets) || !targets.every(isKillTarget)) return [];
  if (signal !== 'SIGTERM' && signal !== 'SIGKILL') return [];
  const { ordered, refused } = planKill(targets.map(({ pid, startTicks }) => ({ pid, startTicks })), readProcesses(), { selfPid: process.pid, currentUid: uid });
  const results = [...refused, ...sendSignals(ordered, signal)];
  const killed = results.filter((r) => r.ok).map((r) => r.pid);
  if (killed.length) {
    try {
      mkdirSync(data, { recursive: true });
      appendFileSync(appEventsPath(data), formatAppEvent({ ts: Date.now(), type: 'app_kill', groupKey: null, detail: { pids: killed, signal } }));
    } catch (e) {
      console.error('app event:', e);
    }
  }
  return results;
});

ipcMain.handle('config:get', () => configState());

ipcMain.handle('config:set', (_e, next: unknown) => {
  const valid = validateConfig(next);
  if (!valid) throw new Error('Configuration invalide');
  const recorderChanged = valid.recorder.enabled !== config.recorder.enabled;
  config = valid;
  protection = compileProtection(config.protected);
  warning = null;
  saveConfig(dir, config);
  if (recorderChanged) void syncRecorder();
  return configState();
});

ipcMain.handle('history:system', (_e, r: unknown) => (isRange(r) ? history.system(r) : null));
ipcMain.handle('history:groups', (_e, r: unknown, keys: unknown) => (isRange(r) && isGroupKeys(keys) ? history.groups(r, keys) : null));
ipcMain.handle('history:group', (_e, key: unknown, r: unknown) => (typeof key === 'string' && isRange(r) ? history.group(key, r) : null));
ipcMain.handle('history:procs', (_e, key: unknown, r: unknown) => (typeof key === 'string' && isRange(r) ? history.procs(key, r) : null));
ipcMain.handle('history:culprits', (_e, ts: unknown) => (Number.isFinite(ts) ? history.culprits(ts as number) : []));
ipcMain.handle('history:top', (_e, r: unknown, o: unknown) => (isRange(r) && isTopOptions(o) ? history.top(r, o) : { byAvg: [], byMax: [] }));
ipcMain.handle('history:events', (_e, r: unknown) => (isRange(r) ? history.events(r) : []));
ipcMain.handle('recorder:status', () => recorderState());
ipcMain.handle('recorder:setEnabled', async (_e, enabled: unknown) => {
  if (typeof enabled !== 'boolean') throw new Error('Valeur invalide');
  const next = { ...config, recorder: { ...config.recorder, enabled } };
  saveConfig(dir, next);
  config = next;
  await syncRecorder();
  return recorderState();
});
ipcMain.handle('recorder:clearHistory', () => clearHistory(data, { running: recorderState().running, beforeDelete: history.close }));

ipcMain.handle('desktop:install', () => {
  if (!app.isPackaged) throw new Error('Disponible uniquement dans la version installée (AppImage ou .deb)');
  return installDesktopEntry(process.env.APPIMAGE || process.execPath);
});

app.whenReady().then(() => {
  createWindow();
  void syncRecorder();
});
app.on('window-all-closed', () => app.quit());
