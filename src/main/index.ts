import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray } from 'electron';
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { classifyGroups, type InstanceDecision } from '../core/classify/classify';
import { readPackageHints } from '../core/classify/packageJson';
import { CpuTracker } from '../core/collector/cpuTracker';
import { readListeningPorts } from '../core/collector/ports';
import { applyPss, PssCache, pssTargets } from '../core/collector/pss';
import { readProcesses, type CwdEntry, type StatusEntry } from '../core/collector/readProcesses';
import { readSystem } from '../core/collector/readSystem';
import { configDir, loadConfig, saveConfig } from '../core/config';
import { buildGroups, isOverThreshold } from '../core/grouping/buildGroups';
import { claudeDirs } from '../core/grouping/claudeDirs';
import { createProjectRootCache } from '../core/grouping/projectRootCache';
import { recordSeparate, stickyIds } from '../core/grouping/stickyCards';
import { killRequest, planKill, sendSignals } from '../core/kill';
import { compileProtection } from '../core/protection';
import { formatAppEvent } from '../core/history/events';
import { appEventsPath, dataDir, focusStatePath, forecastSnoozePath, rulesSimulationPath } from '../core/paths';
import { readSimStatsFile } from '../core/rules/simulationFile';
import { alertIdFromArgv } from '../core/alerts';
import { buildSnapshot, flattenGroup, groupProcs, instanceTargets, isWatch, othersFollowed, type Classification, type FullSnapshot } from '../core/snapshot';
import type { ConfigState, Group, KillResult, ProcInfo, RecorderState, Watch } from '../core/types';
import { createFreeOpener, wantsFree } from './launchArgs';
import { SNOOZE_MS } from '../core/forecast/forecast';
import { writeSnooze } from '../core/forecast/snooze';
import { createAlertOpener, createFocusWriter, initSeenUpTo, keepSeenUpTo, markSeen, unseenFilter } from './alerts';
import { installDesktopEntry } from './desktopEntry';
import { createEarlyoomApplier, earlyoomStatus } from './earlyoom';
import { clearHistory, createHistoryReader } from './history';
import { pollDelay, type WindowActivity } from './pollPolicy';
import { sharedScan } from './tmpUsage';
import { closeAction, confirmTray, createTrayController, defaultRun, statusNotifierAvailable, type TrayController } from './tray';
import {
  applyOverride, checkConfigSet, classifySetKey, isGroupKeys, noKill, isInstanceKeys, isOptionalGroupKey, isProcTreeRequest, isRange, isSinceMs, isTopOptions, recorderState as computeRecorderState,
} from './historyIpc';
import { autoManageService, defaultSystemctl, recorderSyncDisabled, ensureRecorderService, recorderExecArgs, systemctlAvailable, unitPath } from './recorderService';

// Service réseau dans le processus main : l'app ne charge que des fichiers locaux, un processus de moins (~20 Mo).
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess2');

// Instance unique : un second lancement (bouton « Ouvrir » d'une notification, menu) réveille la fenêtre existante.
const primary = app.requestSingleInstanceLock();
if (!primary) {
  // `npm run dev` / `npm start` pendant que l'app de l'utilisateur tourne avec la même config : pas un plantage.
  console.error(
    "proc-watch est déjà ouvert avec cette configuration (XDG_CONFIG_HOME) : sa fenêtre est affichée et ce lancement s'arrête. " +
      'Pour une seconde instance, lancer avec un XDG_CONFIG_HOME temporaire.',
  );
  app.quit();
}

const dir = configDir();
const loaded = loadConfig(dir);
let config = loaded.config;
let warning = loaded.warning;
/** Règles du fichier refusées à la lecture (ignorées seules) : affichées dans Réglages › Règles jusqu'au prochain enregistrement. */
let ruleIssues = loaded.ruleIssues ?? [];
{
  // Alertes « vues » jusqu'à maintenant au premier lancement : pas de pop-up pour l'historique déjà enregistré.
  const init = initSeenUpTo(config, Date.now());
  if (init) {
    config = init;
    if (primary && !loaded.warning) {
      try {
        saveConfig(dir, config);
      } catch (e) {
        console.error('config:', e);
      }
    }
  }
}
let protection = compileProtection(config.protected);
const tracker = new CpuTracker();
const uid = process.getuid!();

const projectRootOf = createProjectRootCache();
/** Dossiers de config de Claude : les processus qui y travaillent (outils détachés) rejoignent le groupe Claude. */
const claudeConfigDirs = claudeDirs();

const data = dataDir();
const focusWriter = createFocusWriter({
  write: (json) => {
    const file = focusStatePath(data);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, json, { mode: 0o600 });
    renameSync(tmp, file);
  },
});
const alertOpener = createAlertOpener((id) => {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('alert:open', id);
});
// « Libérer de la mémoire » (`--free`) : le renderer ouvre le kill groupé pré-rempli (rien n'est tué sans confirmation).
const freeOpener = createFreeOpener(() => {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('free');
});
const history = createHistoryReader(data, () => config.recorder);
let systemdOk = false;

const execArgs = () => recorderExecArgs({ appImage: process.env.APPIMAGE, execPath: process.execPath, appPath: app.getAppPath() });

/** `explicit` : action de l'utilisateur (réglage) ; sinon synchronisation au démarrage (création réservée à autoManageService). */
async function doSync(explicit: boolean): Promise<void> {
  systemdOk = await systemctlAvailable(defaultSystemctl);
  if (!systemdOk || recorderSyncDisabled()) return;
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

// Classement : ports en écoute relus au plus toutes les 10 s (groupes projet / dossier supprimé + instances db) ;
// décisions en cache par instance (racine + empreinte des pid:startTicks de ses processus), cache vidé quand les corrections
// ou les ports changent,
// et toutes les 60 s (durée du cache de package.json).
const PORTS_EVERY_MS = 10_000;
const DECISIONS_MAX_AGE_MS = 60_000;
let ports = new Map<number, number[]>();
let portsKey = '';
let portsAt = 0;
let portsVersion = 0;
let overridesVersion = 0;
const decisions = new Map<string, InstanceDecision>();
let decisionsFor = '';
let decisionsAt = 0;
let lastClassification: Classification = new Map();

function refreshPorts(groups: Group[], now: number): void {
  if (!config.classify.detectPorts) {
    if (ports.size) {
      ports = new Map();
      portsKey = '';
      portsVersion++;
    }
    return;
  }
  if (now - portsAt >= 0 && now - portsAt < PORTS_EVERY_MS) return;
  portsAt = now;
  const pids = new Set<number>();
  const visit = (g: Group) => {
    if (g.kind === 'project' || g.kind === 'deleted') for (const p of flattenGroup(g)) pids.add(p.pid);
    else g.subgroups.forEach(visit);
  };
  groups.forEach(visit);
  // instances db : d'après le classement précédent
  for (const c of lastClassification.values()) for (const i of c.instances) if (i.category === 'db') i.pids.forEach((pid) => pids.add(pid));
  const next = pids.size ? readListeningPorts([...pids]) : new Map<number, number[]>();
  const key = JSON.stringify([...next].sort((a, b) => a[0] - b[0]));
  if (key !== portsKey) {
    portsKey = key;
    ports = next;
    portsVersion++;
  }
}

function classify(groups: Group[], now: number): Classification {
  const version = `${overridesVersion}:${portsVersion}`;
  if (version !== decisionsFor || !(now - decisionsAt >= 0 && now - decisionsAt < DECISIONS_MAX_AGE_MS)) {
    decisions.clear();
    decisionsFor = version;
    decisionsAt = now;
  }
  lastClassification = classifyGroups(groups, {
    overrides: config.classify.overrides,
    ports,
    pkg: (root) => readPackageHints(root),
    isProtected: protection.isProtected,
    memo: decisions,
    // Les centaines de sous-groupes de « Autres » ne sont classés que s'ils sont affichés (≈ 80 % du coût du classement).
    skipOthersSubgroups: !othersFollowed(groups, watch),
  });
  return lastClassification;
}

// Option PSS : smaps_rollup des processus des groupes affichés (d'après le snapshot précédent), au plus toutes les 10 s.
const pssCache = new PssCache();

/** Mode PSS : remplace le RSS par le PSS des processus affichés ; sinon aucun accès à smaps_rollup. */
function withPss(procs: ProcInfo[], now: number): ProcInfo[] {
  if (config.ui.memoryMetric !== 'pss') {
    pssCache.clear();
    return procs;
  }
  if (!last) return applyPss(procs, new Map(), true); // premier tick : tout reste en RSS, signalé
  // Sous-groupes de « Autres » au-dessus du seuil en RSS : ils n'y sont que grâce à leur PSS, qu'il faut donc garder à jour.
  let rss: Map<number, number> | undefined;
  const overInRss = (sub: Group) => {
    rss ??= new Map(procs.map((p) => [p.pid, p.rssKB]));
    let kb = 0;
    for (const p of flattenGroup(sub)) kb += (rss.get(p.pid) ?? p.rssKB) + p.swapKB;
    return kb >= config.othersThreshold.memMB * 1024;
  };
  const targets = pssTargets(last.groups, othersFollowed(last.groups, watch), overInRss);
  return applyPss(procs, pssCache.update(targets, now), true);
}

function takeSnapshot(): FullSnapshot {
  const now = Date.now();
  const samples = readProcesses('/proc', {
    cmdlineCache,
    cwdCache: { entries: cwdEntries, now, maxAgeMs: CWD_MAX_AGE_MS },
    statusCache: { entries: statusEntries, now, maxAgeMs: STATUS_MAX_AGE_MS },
  });
  const procs = withPss(tracker.update(samples, now), now);
  const sticky = stickyIds(separateSeen, now, CARD_HOLD_MS);
  const groups = buildGroups(procs, {
    home: homedir(),
    currentUid: uid,
    isProtected: protection.isProtected,
    othersThreshold: config.othersThreshold,
    projectRootOf,
    keepSeparate: (id) => sticky.has(id),
    claudeDirs: claudeConfigDirs,
  });
  recordSeparate(separateSeen, groups, now, (g) => isOverThreshold(g, config.othersThreshold));
  refreshPorts(groups, now);
  const classification = classify(groups, now);
  return { takenAt: Date.now(), currentUid: uid, system: readSystem(), groups, classification, memMetric: config.ui.memoryMetric };
}

/** Dernier snapshot complet (arbres compris) : sert au kill de groupe et aux réponses immédiates à `watch`. */
let last: FullSnapshot | null = null;
let watch: Watch = { groupId: null, query: '' };
let mainWin: BrowserWindow | null = null;
// Demandes du lancement (`--alert=<id>`, `--free`) : gardées jusqu'à ce que le renderer les prenne. Après la déclaration de
// mainWin (l'envoi immédiat la lit : avant, ReferenceError au démarrage).
{
  const id = alertIdFromArgv(process.argv);
  if (id !== null) alertOpener.open(id);
}
if (wantsFree(process.argv)) freeOpener.open();

function send(): void {
  if (!mainWin || mainWin.isDestroyed() || !last) return;
  mainWin.webContents.send('snapshot', buildSnapshot(last, watch));
}

const configState = (): ConfigState => ({ config, warning, invalid: protection.invalid, ...(ruleIssues.length ? { ruleIssues } : {}) });

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
  // Fermer la fenêtre la cache dans la barre des tâches (si l'icône y est réellement) ; le `hide` qui suit suspend la collecte.
  // Avant de cacher, la zone de notification est revérifiée (hôte toujours là ?) : non, erreur ou plus de 1 s → on quitte,
  // jamais de fenêtre invisible sans moyen de la rouvrir.
  let closing = false;
  win.on('close', (e) => {
    if (closeAction({ closeToTray: config.ui.closeToTray, trayActive: trayCtl?.active() === true, quitting }) !== 'hide') return;
    e.preventDefault();
    if (closing) return;
    closing = true;
    void confirmTray(() => statusNotifierAvailable(defaultRun)).then((ok) => {
      closing = false;
      if (win.isDestroyed() || quitting) return;
      if (ok && trayCtl?.active()) win.hide();
      else {
        quitting = true;
        app.quit();
      }
    });
  });
  win.on('minimize', () => {
    focusWriter.set(false);
    pause();
  });
  win.on('hide', () => {
    focusWriter.set(false);
    pause();
  });
  win.on('restore', resume);
  win.on('show', () => activity.hidden && resume());
  win.on('blur', () => {
    activity.blurredAt = Date.now();
    focusWriter.set(false);
  });
  win.on('focus', () => {
    focusWriter.set(true);
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
    focusWriter.set(false);
    if (timer) clearTimeout(timer);
    timer = null;
    mainWin = null;
  });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(__dirname, '../renderer/index.html'));
}

ipcMain.handle('kill', (_e, raw: unknown, rawSignal: unknown): KillResult[] => {
  // Au-delà de MAX_KILL_TARGETS : erreur (le renderer découpe en lots).
  const req = killRequest(raw, rawSignal);
  if (!req) return [];
  const { targets, signal } = req;
  // vérifications visuelles : aucun signal
  if (noKill()) return [...new Set(targets.map((t) => t.pid))].map((pid) => ({ pid, ok: false, error: 'NOKILL' }));
  const { ordered, refused } = planKill(targets, readProcesses(), { selfPid: process.pid, currentUid: uid });
  const results = [...refused, ...sendSignals(ordered, signal)];
  const killed = results.filter((r) => r.ok).map((r) => r.pid);
  const killedSet = new Set(killed);
  // Identité exacte des cibles : rattache le kill au bon processus dans l'historique (alertes du détail), même si le PID est réutilisé.
  const killedTargets = targets.filter((t) => killedSet.has(t.pid)).map((t) => ({ pid: t.pid, startTicks: t.startTicks }));
  if (killed.length) {
    try {
      mkdirSync(data, { recursive: true });
      appendFileSync(appEventsPath(data), formatAppEvent({ ts: Date.now(), type: 'app_kill', groupKey: null, detail: { pids: killed, signal, targets: killedTargets } }));
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
  watch = { groupId: w.groupId, query: w.query, othersOpen: w.othersOpen === true };
  // « Autres » déplié, ou ouverture de « Autres » / d'un de ses sous-groupes : leur classement est calculé tout de suite (reclassify envoie).
  const others = last?.groups.find((g) => g.kind === 'others');
  const unclassified = !!others && others.subgroups.length > 0 && !last!.classification.has(others.subgroups[0].id);
  if (unclassified && othersFollowed(last!.groups, watch)) reclassify();
  else send();
});
ipcMain.handle('group:procs', (_e, id: unknown) => (typeof id === 'string' && last ? groupProcs(last.groups, id) : []));

ipcMain.handle('config:set', (_e, next: unknown) => {
  // validation stricte (règles comprises) et transition des règles : une nouvelle règle démarre en Simulation
  const checked = checkConfigSet(next, config, readSimStatsFile(rulesSimulationPath(data)));
  const valid = keepSeenUpTo(checked, config);
  const recorderChanged = valid.recorder.enabled !== config.recorder.enabled;
  const trayChanged = valid.ui.trayIcon !== config.ui.trayIcon;
  if (valid.classify.detectPorts !== config.classify.detectPorts) portsAt = 0;
  const overridesChanged = JSON.stringify(valid.classify.overrides) !== JSON.stringify(config.classify.overrides);
  config = valid;
  if (overridesChanged) overridesVersion++; // autre réglage : le cache de classement reste valable
  protection = compileProtection(config.protected);
  warning = null;
  ruleIssues = [];
  saveConfig(dir, config);
  if (recorderChanged) void syncRecorder(true);
  if (trayChanged) void syncTray();
  // Correction retirée depuis les Réglages : classement à jour sans attendre le prochain tick (fenêtre réduite comprise).
  if (overridesChanged) reclassify();
  return configState();
});

/** Recalcule le classement du dernier snapshot (sans relire /proc) et le renvoie au renderer. */
function reclassify(): void {
  if (!last) return;
  last = { ...last, classification: classify(last.groups, Date.now()) };
  send();
}

// Correction manuelle : sauvegardée avant d'être appliquée (une sauvegarde qui échoue ne change rien).
ipcMain.handle('classify:set', (_e, scope: unknown, signature: unknown, category: unknown): ConfigState => {
  const v = classifySetKey(scope, signature, category);
  if (!v) throw new Error('Correction invalide');
  const overrides = applyOverride(config.classify.overrides, v.key, v.category);
  if (!overrides) throw new Error('Trop de corrections (500 au plus)');
  const next = { ...config, classify: { ...config.classify, overrides } };
  saveConfig(dir, next);
  config = next;
  overridesVersion++;
  reclassify();
  return configState();
});

/** Clés des instances (du dernier snapshot) sans échantillon CPU ≥ 1 % depuis `since` ; null sans base d'historique. */
ipcMain.handle('classify:inactive', (_e, keys: unknown, since: unknown): string[] | null => {
  if (!isInstanceKeys(keys) || !isSinceMs(since)) throw new Error('Requête invalide');
  if (!last) return [];
  const known = new Set<string>();
  for (const c of last.classification.values()) for (const i of c.instances) known.add(i.key);
  const entries = instanceTargets(last, keys.filter((k) => known.has(k)));
  const active = history.active(entries.flatMap((e) => e.targets), since);
  if (!active) return null;
  return entries.filter((e) => !e.targets.some((t) => active.has(`${t.pid}:${t.startTicks}`))).map((e) => e.key);
});

/** Cibles de kill des instances (ou lanceurs d'un groupe) d'après le dernier snapshot ; instances disparues absentes. */
ipcMain.handle('instances:targets', (_e, keys: unknown) => {
  if (!isInstanceKeys(keys)) throw new Error('Requête invalide');
  return last ? instanceTargets(last, keys) : [];
});

ipcMain.handle('history:system', (_e, r: unknown) => (isRange(r) ? history.system(r) : null));
ipcMain.handle('history:groups', (_e, r: unknown, keys: unknown) => (isRange(r) && isGroupKeys(keys) ? history.groups(r, keys) : null));
ipcMain.handle('history:group', (_e, key: unknown, r: unknown) => (typeof key === 'string' && isRange(r) ? history.group(key, r) : null));
ipcMain.handle('history:procs', (_e, key: unknown, r: unknown) => (typeof key === 'string' && isRange(r) ? history.procs(key, r) : null));
ipcMain.handle('history:procTree', (_e, key: unknown, ts: unknown) => (isProcTreeRequest(key, ts) ? history.procTree(key as string, ts as number) : null));
ipcMain.handle('history:culprits', (_e, ts: unknown) => (Number.isFinite(ts) ? history.culprits(ts as number) : []));
ipcMain.handle('history:top', (_e, r: unknown, o: unknown) => (isRange(r) && isTopOptions(o) ? history.top(r, o) : { byAvg: [], byMax: [] }));
ipcMain.handle('history:events', (_e, r: unknown, groupKey: unknown) => (isRange(r) && isOptionalGroupKey(groupKey) ? history.events(r, groupKey) : []));
const tmpTopDirs = sharedScan();
ipcMain.handle('tmp:topDirs', () => tmpTopDirs());
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

ipcMain.handle('earlyoom:status', () => earlyoomStatus());
/** Confirmation dans le main, avec la ligne exacte que le main a construite, avant tout pkexec. */
const confirmEarlyoomLine = async (line: string): Promise<boolean> => {
  const opts: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'earlyoom',
    message: 'Écrire cette ligne dans /etc/default/earlyoom et redémarrer earlyoom ?',
    detail: line,
    buttons: ['Annuler', 'Écrire et redémarrer'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
  return r.response === 1;
};
const applyEarlyoomIpc = createEarlyoomApplier(() => config.protected, confirmEarlyoomLine);
ipcMain.handle('earlyoom:apply', (_e, s: unknown, expectedLine: unknown) => applyEarlyoomIpc(s, expectedLine));

ipcMain.handle('desktop:install', () => {
  if (!app.isPackaged) throw new Error('Disponible uniquement dans la version installée (AppImage ou .deb)');
  return installDesktopEntry(process.env.APPIMAGE || process.execPath);
});

ipcMain.handle('alerts:unseen', () => history.unseenAlerts(config.alerts.seenUpTo, unseenFilter(config)));
ipcMain.handle('alerts:get', (_e, id: unknown) => (Number.isSafeInteger(id) && (id as number) > 0 ? history.alert(id as number) : null));
const applySeen = (req: unknown): ConfigState => {
  const next = markSeen(config, req, Date.now(), (ids) => history.alertTimes(ids));
  if (next) {
    saveConfig(dir, next);
    config = next;
  }
  return configState();
};
ipcMain.handle('alerts:markSeen', (_e, req: unknown) => applySeen(req));
// « Tout fermer » : vues jusqu'à la plus récente des alertes non vues (toutes, pas seulement les 100 chargées).
ipcMain.handle('alerts:seenAll', () => {
  const ts = history.newestAlertTs(config.alerts.seenUpTo, unseenFilter(config));
  return ts === null ? configState() : applySeen({ upTo: ts });
});
ipcMain.handle('alerts:takePending', () => alertOpener.take());
ipcMain.handle('rules:stats', () => history.ruleStats());
ipcMain.handle('free:takePending', () => freeOpener.take());
// « Ignorer 30 min » du pop-up de prévision : fichier d'état lu par le service avant toute alerte de prévision.
ipcMain.handle('forecast:snooze', () => {
  const at = Date.now();
  const until = at + SNOOZE_MS;
  writeSnooze(forecastSnoozePath(data), until, at);
  return until;
});

/** Montre la fenêtre (la recrée si elle a été fermée), la restaure et la focalise. */
function showWindow(): void {
  if (!mainWin || mainWin.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

/** Montre la fenêtre sur « Libérer de la mémoire » (barre des tâches, `--free`). */
function openFree(): void {
  showWindow();
  freeOpener.open();
}

// Icône dans la barre des tâches : seulement si le bureau a une zone de notification (StatusNotifierWatcher), sinon
// fermer la fenêtre quitte comme avant.
let quitting = false;
let trayCtl: TrayController | null = null;
let traySyncing: Promise<void> = Promise.resolve();
app.on('before-quit', () => {
  quitting = true;
});

async function doSyncTray(): Promise<void> {
  if (!config.ui.trayIcon) {
    trayCtl?.stop();
    trayCtl = null;
    return;
  }
  if (trayCtl || !(await statusNotifierAvailable(defaultRun)) || !config.ui.trayIcon || quitting) return;
  trayCtl = createTrayController({
    createTray: (img) => new Tray(img as Electron.NativeImage),
    image: (reps) => {
      const img = nativeImage.createEmpty();
      for (const r of reps) img.addRepresentation({ scaleFactor: r.scaleFactor, buffer: r.png });
      return img;
    },
    menu: (items) => Menu.buildFromTemplate(items),
    watchMenu: (m, onShow, onHide) => {
      (m as Electron.Menu).on('menu-will-show', onShow);
      (m as Electron.Menu).on('menu-will-close', onHide);
    },
    readSystem: () => readSystem(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
    onOpen: showWindow,
    onFree: openFree,
    onQuit: () => {
      quitting = true;
      app.quit();
    },
  });
}

/** Crée ou retire l'icône selon `config.ui.trayIcon` (appels sérialisés). */
function syncTray(): Promise<void> {
  const run = () => doSyncTray().catch((e) => console.error('tray:', e));
  traySyncing = traySyncing.then(run, run);
  return traySyncing;
}

/**
 * Pour Réglages › Affichage : zone de notification présente et, si l'icône est demandée, icône réellement créée
 * (créée maintenant si elle manque : zone apparue après le démarrage).
 */
ipcMain.handle('tray:available', async () => {
  const ok = await statusNotifierAvailable(defaultRun);
  if (!ok || !config.ui.trayIcon) return ok;
  if (!trayCtl) await syncTray();
  return trayCtl?.active() === true;
});

app.on('second-instance', (_e, argv) => {
  if (wantsFree(argv)) openFree();
  else showWindow();
  const id = alertIdFromArgv(argv);
  if (id !== null) alertOpener.open(id);
});

app.whenReady().then(() => {
  if (!primary) return;
  createWindow();
  void syncRecorder(false);
  void syncTray();
});
app.on('window-all-closed', () => app.quit());
