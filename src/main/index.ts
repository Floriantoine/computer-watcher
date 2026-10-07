import { app, BrowserWindow, ipcMain } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CpuTracker } from '../core/collector/cpuTracker';
import { readProcesses } from '../core/collector/readProcesses';
import { readSystem } from '../core/collector/readSystem';
import { configDir, loadConfig, saveConfig, validateConfig } from '../core/config';
import { buildGroups } from '../core/grouping/buildGroups';
import { findProjectRoot } from '../core/grouping/projectRoot';
import { planKill, sendSignals } from '../core/kill';
import { compileProtection } from '../core/protection';
import type { ConfigState, KillResult, KillTarget, Snapshot } from '../core/types';
import { installDesktopEntry } from './desktopEntry';

const POLL_MS = 2000;
const dir = configDir();
const loaded = loadConfig(dir);
let config = loaded.config;
let warning = loaded.warning;
let protection = compileProtection(config.protected);
const tracker = new CpuTracker();
const uid = process.getuid!();

const rootCache = new Map<string, string | null>();
function projectRootOf(cwd: string): string | null {
  if (rootCache.size > 5000) rootCache.clear();
  if (!rootCache.has(cwd)) rootCache.set(cwd, findProjectRoot(cwd));
  return rootCache.get(cwd)!;
}

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
  return [...refused, ...sendSignals(ordered, signal)];
});

ipcMain.handle('config:get', () => configState());

ipcMain.handle('config:set', (_e, next: unknown) => {
  const valid = validateConfig(next);
  if (!valid) throw new Error('Configuration invalide');
  config = valid;
  protection = compileProtection(config.protected);
  warning = null;
  saveConfig(dir, config);
  return configState();
});

ipcMain.handle('desktop:install', () => {
  if (!app.isPackaged) throw new Error('Disponible uniquement dans la version installée (AppImage ou .deb)');
  return installDesktopEntry(process.env.APPIMAGE || process.execPath);
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
