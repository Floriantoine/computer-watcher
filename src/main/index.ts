import { app, BrowserWindow, ipcMain } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CpuTracker } from '../core/collector/cpuTracker';
import { readProcesses, type CwdEntry, type StatusEntry } from '../core/collector/readProcesses';
import { readSystem } from '../core/collector/readSystem';
import { configDir, loadConfig, saveConfig, validateConfig } from '../core/config';
import { buildGroups } from '../core/grouping/buildGroups';
import { createProjectRootCache } from '../core/grouping/projectRootCache';
import { recordSeparate, stickyIds } from '../core/grouping/stickyCards';
import { planKill, sendSignals } from '../core/kill';
import { compileProtection } from '../core/protection';
import { formatAppEvent } from '../core/history/events';
import { appEventsPath, dataDir } from '../core/paths';
import { buildSnapshot, groupProcs, isWatch, type FullSnapshot } from '../core/snapshot';
import type { ConfigState, KillResult, KillTarget, RecorderState, Watch } from '../core/types';
import { installDesktopEntry } from './desktopEntry';
import { clearHistory, createHistoryReader } from './history';
import { pollDelay, type WindowActivity } from './pollPolicy';
import { isGroupKeys, isRange, isTopOptions, recorderState as computeRecorderState } from './historyIpc';
import { autoManageService, defaultSystemctl, ensureRecorderService, recorderExecArgs, systemctlAvailable, unitPath } from './recorderService';

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

/** `explicit` : action de l'utilisateur (réglage) ; sinon synchronisation au démarrage (création réservée à autoManageService). */
async function doSync(explicit: boolean): Promise<void> {
  systemdOk = await systemctlAvailable(defaultSystemctl);
  if (!systemdOk) return;
  // Au démarrage en dev (non empaqueté, sans PROC_WATCH_RECORDER_DEV) : jamais de création d'unité, mais une unité
  // existante est tenue à jour (ou retirée si l'historique est désactivé), comme en mode empaqueté.
  const allowCreate = explicit || autoManageService(app.isPackaged);
  try {
    await ensureRecorderService({ enabled: config.recorder.enabled, args: execArgs(), path: unitPath(), run: defaultSystemctl, allowCreate });
  } catch (e) {
    console.error('recorder service:', e);
  }
}

let syncing: Promise<void> = Promise.resolve();
/** Sérialise les synchronisations pour éviter des appels systemctl concurrents. */
function syncRecorder(explicit: boolean): Promise<void> {
  const run = () => doSync(explicit);
  syncing = syncing.then(run, run);
  return syncing;
}

const recorderState = (): RecorderState =>
  computeRecorderState({ available: systemdOk, enabled: config.recorder.enabled, intervalSec: config.recorder.intervalSec, status: history.status(), now: Date.now() });

// Caches de collecte : cmdline lue une fois par processus, lien cwd relu au plus toutes les 30 s par processus,
// status relu si le RSS change ou toutes les 10 s (swap et uid au plus 10 s en retard pour un processus endormi).
const cmdlineCache = new Map<string, string>();
const cwdEntries = new Map<string, CwdEntry>();
const statusEntries = new Map<string, StatusEntry>();
const CWD_MAX_AGE_MS = 30_000;
const STATUS_MAX_AGE_MS = 10_000;
/** Une carte affichée reste affichée 30 s après être repassée sous les seuils de « Autres » (pas de clignotement). */
const separateSeen = new Map<string, number>();
const CARD_HOLD_MS = 30_000;

function takeSnapshot(): FullSnapshot {
  const now = Date.now();
  const samples = readProcesses('/proc', {
    cmdlineCache,
    cwdCache: { entries: cwdEntries, now, maxAgeMs: CWD_MAX_AGE_MS },
    statusCache: { entries: statusEntries, now, maxAgeMs: STATUS_MAX_AGE_MS },
  });
  const procs = tracker.update(samples, now);
  const sticky = stickyIds(separateSeen, now, CARD_HOLD_MS);
  const groups = buildGroups(procs, {
    home: homedir(),
    currentUid: uid,
    isProtected: protection.isProtected,
    othersThreshold: config.othersThreshold,
    projectRootOf,
    keepSeparate: (id) => sticky.has(id),
  });
  recordSeparate(separateSeen, groups, now);
  return { takenAt: Date.now(), currentUid: uid, system: readSystem(), groups };
}

/** Dernier snapshot complet (arbres compris) : sert au kill de groupe et aux réponses immédiates à `watch`. */
let last: FullSnapshot | null = null;
let watch: Watch = { groupId: null, query: '' };
let mainWin: BrowserWindow | null = null;

function send(): void {
  if (!mainWin || mainWin.isDestroyed() || !last) return;
  mainWin.webContents.send('snapshot', buildSnapshot(last, watch));
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
  mainWin = win;
  const push = () => {
    if (win.isDestroyed()) return;
    try {
      last = takeSnapshot();
      send();
    } catch (err) {
      console.error('snapshot failed:', err);
    }
  };
  // Collecte en direct : arrêtée fenêtre réduite ou cachée, ralentie après une minute sans focus (voir pollPolicy).
  const activity: WindowActivity = { hidden: false, blurredAt: null };
  let timer: NodeJS.Timeout | null = null;
  let timerDelay: number | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    timerDelay = pollDelay(activity, Date.now());
    if (timerDelay !== null)
      timer = setTimeout(() => {
        push();
        schedule();
      }, timerDelay);
  };
  const setLive = (live: boolean) => {
    if (!win.isDestroyed()) win.webContents.send('live', live);
  };
  const pause = () => {
    activity.hidden = true;
    schedule();
    setLive(false);
  };
  const resume = () => {
    const wasHidden = activity.hidden;
    activity.hidden = false;
    push(); // snapshot frais tout de suite
    schedule();
    if (wasHidden) setLive(true);
  };
  win.on('minimize', pause);
  win.on('hide', pause);
  win.on('restore', resume);
  win.on('show', () => activity.hidden && resume());
  win.on('blur', () => {
    activity.blurredAt = Date.now();
  });
  win.on('focus', () => {
    const slowed = timerDelay !== pollDelay({ ...activity, blurredAt: null }, Date.now());
    activity.blurredAt = null;
    // Sous Wayland, une fenêtre réduite par l'app puis restaurée par le compositeur ne reçoit que `focus`.
    if (activity.hidden || slowed) resume();
  });
  win.webContents.on('did-finish-load', () => {
    push();
    schedule();
  });
  win.on('closed', () => {
    if (timer) clearTimeout(timer);
    timer = null;
    mainWin = null;
  });
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

// Le renderer dit ce qu'il suit ; on renvoie tout de suite le dernier snapshot recalculé (sans relire /proc).
ipcMain.handle('watch', (_e, w: unknown) => {
  if (!isWatch(w)) return;
  watch = { groupId: w.groupId, query: w.query };
  send();
});
ipcMain.handle('group:procs', (_e, id: unknown) => (typeof id === 'string' && last ? groupProcs(last.groups, id) : []));

ipcMain.handle('config:set', (_e, next: unknown) => {
  const valid = validateConfig(next);
  if (!valid) throw new Error('Configuration invalide');
  const recorderChanged = valid.recorder.enabled !== config.recorder.enabled;
  config = valid;
  protection = compileProtection(config.protected);
  warning = null;
  saveConfig(dir, config);
  if (recorderChanged) void syncRecorder(true);
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
  await syncRecorder(true);
  return recorderState();
});
ipcMain.handle('recorder:clearHistory', () => clearHistory(data, { running: recorderState().running, pid: history.status()?.pid, beforeDelete: history.close }));

ipcMain.handle('desktop:install', () => {
  if (!app.isPackaged) throw new Error('Disponible uniquement dans la version installée (AppImage ou .deb)');
  return installDesktopEntry(process.env.APPIMAGE || process.execPath);
});

app.whenReady().then(() => {
  createWindow();
  void syncRecorder(false);
});
app.on('window-all-closed', () => app.quit());
