import { spawn } from 'node:child_process';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import appIcon from '../../resources/icon.png?asset';
import { appendFileSync, constants as fsConstants, existsSync, lstatSync, realpathSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { classifyGroups, type InstanceDecision } from '../core/classify/classify';
import { readPackageHints } from '../core/classify/packageJson';
import { CpuTracker } from '../core/collector/cpuTracker';
import { readAllListenSockets, readListeningPorts, readListeningPortsSlice } from '../core/collector/ports';
import { applyPss, PssCache, pssTargets } from '../core/collector/pss';
import { readProcesses, type CwdEntry, type StatusEntry } from '../core/collector/readProcesses';
import { readSystem } from '../core/collector/readSystem';
import { configDir, loadConfig, saveConfig } from '../core/config';
import { buildGroups, isOverThreshold } from '../core/grouping/buildGroups';
import { claudeDirs } from '../core/grouping/claudeDirs';
import { createProjectRootCache } from '../core/grouping/projectRootCache';
import { recordSeparate, stickyIds } from '../core/grouping/stickyCards';
import { APP_DISPLAY_NAME, APP_NAME } from '../core/appName';
import { killRequest, planKill, sendSignals } from '../core/kill';
import { compileProtection } from '../core/protection';
import { formatAppEvent } from '../core/history/events';
import { appEventsPath, dataDir, diskFamiliesPath, focusStatePath, forecastSnoozePath, rulesSimulationPath } from '../core/paths';
import { readSimStatsFile } from '../core/rules/simulationFile';
import { alertIdFromArgv } from '../core/alerts';
import { ACTIVE_CPU_PERCENT } from '../core/history/queries';
import { swapTargets, swapView, SWAP_IDLE_MS, SWAP_LOOKBACK_MS, type SwapView } from '../core/swap';
import { buildSnapshot, flattenGroup, groupProcs, instanceTargets, isWatch, othersFollowed, type Classification, type FullSnapshot } from '../core/snapshot';
import type { ConfigState, Group, KillResult, ProcInfo, RecorderState, Watch } from '../core/types';
import { createFreeOpener, hiddenPlacement, secondInstanceAction, startWindowShown, wantsFree } from './launchArgs';
import {
  appPaths, autostartState, installAppImage, launchTarget, rootsFrom, runUninstall, setAutostart, stopRecorderForUninstall,
  configSweepPlan, postExitSweepCommand, sweepTools, uninstallPlan, uninstallSummary, verifyAndDeleteOriginal,
} from './appInstall';
import { isUsableAppImage, realAppImage, testFeedTrust } from './realAppImage';
import { hashNoFollow, writeFileSafe } from './safeFs';
import {
  DELETE_CONSENT_TTL_MS, isUninstallOptions, onboardingSteps, takeDeleteConsent, parseOnboardingFile, serializeOnboarding, shouldOpenOnboarding, startIndex,
  type AboutInfo, type AutostartInfo, type OnboardingFile, type OnboardingInfo,
} from '../core/onboarding';
import { SNOOZE_MS } from '../core/forecast/forecast';
import { writeSnooze } from '../core/forecast/snooze';
import { createAlertOpener, createFocusWriter, initSeenUpTo, keepSeenUpTo, markSeen, unseenFilter } from './alerts';
import { installDesktopEntry, refreshDesktopEntry } from './desktopEntry';
import { installedAppImage, installedElsewhere } from './appImageTrust';
import { acquireLock, blockingSleep } from './singleInstance';
import { userDataPath } from './userDataPath';
import { defaultSystemctlSync, migrateEarly, ownAppImageExes, migrateLate, migrationState, realDirUser, realLegacyInstance, waitPidGone, type MigrateDeps } from './migrateName';
import { migrationLines, type MigrationReport } from '../core/nameMigration';
import { createAppImageBackend } from './appImageUpdate';
import { relaunchDetached, sanitizeAppImageEnv } from './relaunch';
import { createPrefsStore, createReleasesApiBackend, createUpdateController, type UpdateBackend } from './updater';
import { isReleaseUrl, RELEASES_API_URL, testFeedFromEnv, updateMode } from '../core/update';
import { createEarlyoomApplier, earlyoomStatus, type EarlyoomLock } from './earlyoom';
import { createEarlyoomSetup, keepEarlyoomReminder, setupConfirmation, snoozeReminder } from './earlyoomSetup';
import { OS_RELEASE, reminderMode } from '../core/earlyoomSetup';
import { clearHistory, createHistoryReader } from './history';
import { pollDelay, type WindowActivity } from './pollPolicy';
import { portModes } from './portModes';
import { PortSweep } from './portSweep';
import { promises as originalFsp } from 'original-fs';
import type { TmpConfirmSummary, TmpDeleteOutcome } from '../core/tmpClean';
import { confirmText, createSetAsideStore, createTmpCleaner, tmpCleanEvent, tmpRootFromEnv, type CleanFs } from './tmpClean';
import { sharedScan, topTmpDirs } from './tmpUsage';
import { createScanCache, scanHome } from './diskScan';
import { diskRootRunner, runDiskRoot } from './diskRoot';
import { cleanFamilies, diskCleanEvent, realProcByName, staticRefusal, type CleanDeps, type CleanResult } from './diskClean';
import { familyPaths, familyRoots, isFamilyRequest, type FamiliesFile, type FamilyId } from '../core/disk/families';
import { partitionOf, watchedPartitions } from '../core/disk/partitions';
import { openInFileManager } from './diskOpen';
import { defaultDu, measureFamilies, readFamiliesFile, writeFamiliesFile } from '../core/disk/measure';
import { tmpFsStats } from './tmpFsStats';
import { closeAction, confirmTray, createTrayController, defaultRun, statusNotifierAvailable, type TrayController } from './tray';
import {
  applyOverride, checkConfigSet, classifySetKey, swapSettingsChanged, isGroupKeys, noKill, isInstanceKeys, isOptionalGroupKey, isProcTreeRequest, isRange, isSinceMs, isTopOptions, recorderState as computeRecorderState,
} from './historyIpc';
import { autoManageService, defaultSystemctl, recorderSyncDisabled, ensureRecorderService, recorderAppImage, recorderExecArgs, systemctlAvailable, unitPath } from './recorderService';

// Service réseau dans le processus main : l'app ne charge que des fichiers locaux, un processus de moins (~20 Mo).
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess2');

// Nom technique et dossier userData (profil Chromium, verrou d'instance unique) fixés avant toute autre initialisation :
// jamais déduits de productName ni du nom affiché ; userData = dossier de config de l'app (voir userDataPath).
app.setName(APP_NAME);

// Migration proc-watch → computer-watcher, premier temps : après le verrou d'instance unique (pris dans le dossier de config
// résolu, l'ancien tant qu'il n'est pas déplacé), avant toute lecture de la config, de la base ou du service (arrêt de
// l'ancien service, puis déplacement des dossiers) ; userData est ensuite re-résolu. Le second temps (nouveau service,
// entrées du menu, copie AppImage) suit `ready`. Instance encore ouverte, dossier encore utilisé, XDG partiel : rien n'est
// touché. Le démarrage peut attendre jusqu'à une trentaine de secondes au pire (systemctl bloqué, relance qui attend
// l'instance précédente), sans fenêtre : voir defaultSystemctlSync.
/** Relance (mise à jour, installation, « Réessayer ») : relevé avant acquireLock, qui retire ces variables. */
const relaunching = process.env.PROC_WATCH_RELAUNCH === '1' || process.env.APPIMAGE_SILENT_INSTALL === 'true';
function migrationDeps(): MigrateDeps {
  const r = rootsFrom(process.env, homedir());
  return {
    roots: r,
    env: process.env,
    systemctl: defaultSystemctlSync,
    mountinfo: () => {
      try {
        return readFileSync('/proc/self/mountinfo', 'utf8');
      } catch {
        return '';
      }
    },
    legacyInstance: () => realLegacyInstance(r.configHome),
    dirUser: (dir) => realDirUser(dir, { selfExes: ownAppImageExes() }),
    relaunching,
    sleep: blockingSleep,
    writeNewService: async () => {
      await ensureRecorderService({ enabled: config.recorder.enabled, args: execArgs(), path: unitPath(), run: defaultSystemctl, allowCreate: true });
    },
    iconPng: appIcon,
    ownAppImage: () => ownImage,
    // copie AppImage renommée : relance depuis elle, puis sortie (la nouvelle instance supprime l'ancienne copie)
    relaunch: (target) =>
      new Promise<void>((resolve, reject) => {
        quitting = true;
        relaunchDetached({
          ...relaunchHooks(),
          target,
          onStarted: () => {
            setTimeout(() => app.quit(), 50);
            resolve();
          },
          onFailed: (m) => {
            quitting = false;
            reject(new Error(m));
          },
        });
      }),
    now: () => Date.now(),
  };
}
app.setPath('userData', userDataPath());

// Instance unique : un second lancement (bouton « Ouvrir » d'une notification, menu) réveille la fenêtre existante.
// Relance après une mise à jour : la version précédente peut tenir encore le verrou quelques instants (voir acquireLock).
const primary = acquireLock({ tryLock: () => app.requestSingleInstanceLock(), env: process.env, sleep: blockingSleep });
let migration: MigrationReport = { status: 'nothing', done: [], errors: {}, leftInPlace: [], skipped: {} };
if (primary) {
  // « Réessayer » : l'instance précédente a passé son pid ; ses dossiers ne bougent qu'une fois qu'elle a réellement quitté
  const waitPid = Number(process.env.PROC_WATCH_WAIT_PID);
  delete process.env.PROC_WATCH_WAIT_PID;
  const gone = !Number.isInteger(waitPid) || waitPid <= 1 || waitPidGone({ pid: waitPid, sleep: blockingSleep });
  try {
    migration = gone
      ? migrateEarly(migrationDeps())
      : { status: 'deferred', done: [], errors: {}, leftInPlace: [], skipped: {}, detail: `l'instance précédente (pid ${waitPid}) n'a pas quitté` };
  } catch (e) {
    console.error('migration :', e);
    migration = { status: 'partial', done: [], errors: { 'move-dirs': e instanceof Error ? e.message : String(e) }, leftInPlace: [], skipped: {} };
  }
  // dossier de config déplacé : le profil Chromium suit (verrou d'instance compris, déplacé avec lui)
  app.setPath('userData', userDataPath());
} else {
  // second lancement, ou ancienne instance qui tient le verrou de l'ancien dossier : jamais de migration ici
  const holder = realLegacyInstance(rootsFrom(process.env, homedir()).configHome);
  if (holder && migrationState(migrationDeps()).status !== 'done')
    migration = { status: 'deferred', done: [], errors: {}, leftInPlace: [], skipped: {}, detail: `l'ancien dossier est encore utilisé par ${holder.name} (pid ${holder.pid}) ; quitter cette instance, puis relancer Computer Watcher` };
}
/** Différée faute de XDG cohérent (app d'essai) : dit dans le journal et À propos, jamais de boîte bloquante. */
const xdgDeferred = () => migration.status === 'deferred' && /^XDG partiel/.test(migration.detail ?? '');
/** L'ancien service n'est pas (encore) arrêté : jamais de nouveau service à côté de lui (deux enregistreurs). */
const legacyServiceBlocked = () =>
  (migration.status === 'partial' || migration.status === 'deferred') && !migration.done.includes('stop-legacy-service') && !migration.skipped['stop-legacy-service'];
if (!primary) {
  // `npm run dev` / `npm start` pendant que l'app de l'utilisateur tourne avec la même config : pas un plantage.
  console.error(
    `${APP_DISPLAY_NAME} est déjà ouvert avec cette configuration (XDG_CONFIG_HOME) : sa fenêtre est affichée et ce lancement s'arrête. ` +
      'Pour une seconde instance, lancer avec un XDG_CONFIG_HOME temporaire.',
  );
  // migration différée (ancienne version encore ouverte, qui tient le verrou) : le dire avant de s'arrêter
  if (migration.status === 'deferred' && !xdgDeferred())
    void app.whenReady().then(async () => {
      const [message, ...detail] = migrationLines(migration);
      await dialog.showMessageBox({ type: 'warning', title: APP_DISPLAY_NAME, message, detail: detail.join('\n'), buttons: ['OK'], noLink: true });
      app.quit();
    });
  else app.quit();
}

const dir = configDir();
// Premier lancement : la config n'existe pas encore (loadConfig la crée) → assistant d'accueil.
const freshConfig = !existsSync(join(dir, 'config.json'));
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

/** Désinstallation lancée : plus aucune synchronisation du service (il ne doit pas être recréé). */
let uninstalling = false;
/**
 * AppImage de ce processus, vérifiée par realAppImage() — seule source de vérité (accueil, menu, service, mises à jour) :
 * APPDIR est un montage FUSE, le binaire en cours est dessous, APPIMAGE est un fichier ordinaire à en-tête AppImage.
 * Un APPIMAGE hérité d'une autre application, ou posé à la main, n'est jamais utilisé.
 */
// Flux de test des mises à jour (sources + --update-feed-test + flux local) : seul cas où APPDIR est tenu pour un montage.
const updateFeed = testFeedFromEnv(process.env, app.isPackaged, process.argv);
const ownImage = realAppImage(process.env, testFeedTrust(process.env, updateFeed, app.isPackaged));
// n-2 : en AppImage, PATH, LD_LIBRARY_PATH, XDG_DATA_DIRS et GSETTINGS_SCHEMA_DIR sans le montage /tmp, pour tout processus
// lancé ensuite (xdg-open d'openExternal compris) ; APPIMAGE et APPDIR gardés
if (ownImage) sanitizeAppImageEnv(process.env);
/** Dépendances communes des relances détachées (copie installée, version mise à jour). */
const relaunchHooks = () => ({
  env: process.env,
  usable: isUsableAppImage,
  spawn: (cmd: string, args: string[], opts: { detached: true; stdio: 'ignore'; env: NodeJS.ProcessEnv }) => spawn(cmd, args, opts),
  releaseLock: () => app.releaseSingleInstanceLock(),
  reacquireLock: () => app.requestSingleInstanceLock(),
});
/** N1 : copie installée (~/Applications/computer-watcher.AppImage) présente → le service pointe vers elle, jamais vers l'original. */
const execArgs = () =>
  recorderExecArgs({ appImage: recorderAppImage(ownImage, installedAppImage(homedir())) ?? undefined, execPath: process.execPath, appPath: app.getAppPath() });

/**
 * `explicit` : action de l'utilisateur (réglage) ; sinon synchronisation au démarrage (création réservée à autoManageService).
 * `restart` : nouvelle version de l'app (mise à jour) : le service est relancé même si son unité n'a pas changé.
 */
async function doSync(explicit: boolean, restart = false): Promise<boolean> {
  systemdOk = await systemctlAvailable(defaultSystemctl);
  if (!systemdOk || recorderSyncDisabled() || uninstalling || legacyServiceBlocked()) return false;
  // Au démarrage en dev (non empaqueté, sans PROC_WATCH_RECORDER_DEV) : jamais de création d'unité, mais une unité
  // existante est tenue à jour (ou retirée si l'historique est désactivé), comme en mode empaqueté.
  const allowCreate = explicit || autoManageService(app.isPackaged);
  try {
    await ensureRecorderService({ enabled: config.recorder.enabled, args: execArgs(), path: unitPath(), run: defaultSystemctl, allowCreate, restart });
    return true;
  } catch (e) {
    console.error('recorder service:', e);
    return false;
  }
}

let syncing: Promise<unknown> = Promise.resolve();
/** Sérialise les synchronisations pour éviter des appels systemctl concurrents ; vrai si la synchronisation a abouti. */
function syncRecorder(explicit: boolean, restart = false): Promise<boolean> {
  const run = () => doSync(explicit, restart);
  const next = syncing.then(run, run);
  syncing = next;
  return next;
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
// panneau « Ports ouverts » affiché ou recherche `:port` : ports de tous les processus de l'utilisateur, même cadence, lus
// par tranches hors du tick (PortSweep) ; le classement garde son périmètre habituel ;
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
// Mode « tous les ports » : lecture par tranches planifiées, hors du tick (voir PortSweep).
const portSweep = new PortSweep({
  readSockets: () => readAllListenSockets(),
  readSlice: (pids, start, sockets, maxFds) => readListeningPortsSlice(pids, start, sockets, maxFds),
  pids: () => {
    if (!last) return [];
    // Périmètre du classement (projets, dossiers supprimés) en tête, puis les autres processus de l'utilisateur.
    const all = last.groups.flatMap(flattenGroup).filter((p) => p.uid === uid);
    const first = new Set<number>();
    for (const g of last.groups) if (g.kind === 'project' || g.kind === 'deleted') for (const p of flattenGroup(g)) first.add(p.pid);
    return [...first, ...all.map((p) => p.pid).filter((pid) => !first.has(pid))];
  },
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (h) => clearTimeout(h as NodeJS.Timeout),
  now: () => Date.now(),
  onDone: (listen) => {
    if (!last) return;
    last = { ...last, listen };
    send();
  },
});

/** Fenêtre cachée, réduite ou fermée : aucune lecture des ports de tous les processus (pause() arrête la passe en cours). */
let windowHidden = true;
const sweepWanted = () => portModes({ detectPorts: config.classify.detectPorts, watch, visible: !windowHidden }).sweep;

function refreshPorts(groups: Group[], now: number): void {
  if (!portModes({ detectPorts: config.classify.detectPorts, watch, visible: !windowHidden }).classify) {
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
  portSweep.setMode(sweepWanted());
  portSweep.tick(); // la passe lit `last` : planifiée, elle s'exécute après ce snapshot
  return { takenAt: Date.now(), currentUid: uid, system: readSystem(), groups, classification, memMetric: config.ui.memoryMetric, listen: portSweep.listen };
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

/** `shown` faux (`--hidden`) : fenêtre créée cachée, collecte suspendue ; placée ensuite (barre des tâches ou réduite). */
function createWindow(shown = true): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: shown,
    title: APP_DISPLAY_NAME,
    icon: appIcon,
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
  const activity: WindowActivity = { hidden: !shown, blurredAt: null };
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
    windowHidden = true;
    portSweep.setMode(false);
    schedule();
    setLive(false);
  };
  const resume = () => {
    const wasHidden = activity.hidden;
    activity.hidden = false;
    windowHidden = false;
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
    windowHidden = activity.hidden;
    push();
    schedule();
  });
  win.on('closed', () => {
    focusWriter.set(false);
    windowHidden = true;
    portSweep.setMode(false);
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
  watch = { groupId: w.groupId, query: w.query, othersOpen: w.othersOpen === true, ports: w.ports === true };
  // Panneau « Ports ouverts » ouvert ou recherche `:port` commencée : passe planifiée tout de suite (jamais ici, en synchrone) ;
  // sortie du mode : liste effacée.
  portSweep.setMode(sweepWanted()); // reçu fenêtre cachée : aucune passe lancée
  if (last && last.listen !== portSweep.listen) last = { ...last, listen: portSweep.listen };
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
  const valid = keepEarlyoomReminder(keepSeenUpTo(checked, config), config);
  const recorderChanged = valid.recorder.enabled !== config.recorder.enabled;
  const trayChanged = valid.ui.trayIcon !== config.ui.trayIcon;
  if (valid.classify.detectPorts !== config.classify.detectPorts) portsAt = 0;
  const overridesChanged = JSON.stringify(valid.classify.overrides) !== JSON.stringify(config.classify.overrides);
  if (swapSettingsChanged(config, valid)) history.clearSwapCache();
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

/**
 * Vue swap (onglet Métriques) d'après le dernier snapshot : swap déjà lu par la collecte (VmSwap), dernière activité CPU lue
 * dans l'historique seulement pour les processus des groupes au-dessus du seuil, sur au plus 7 jours (lecture par tranches,
 * jamais un long blocage du main). Seuil d'activité : max(1, procMinCpuPercent) — en dessous, un petit processus peut ne pas
 * être enregistré du tout. Couverture de l'historique (service arrêté, trous) vérifiée sur la même fenêtre.
 */
ipcMain.handle('swap:view', async (): Promise<SwapView | null> => {
  const full = last;
  if (!full) return null;
  const minSwapKB = config.ui.swapSleepMinMB * 1024;
  const rec = config.recorder;
  const activeCpu = Math.max(ACTIVE_CPU_PERCENT, rec.procMinCpuPercent);
  const lookback = Math.min(rec.summaryDays * 86_400_000, SWAP_LOOKBACK_MS);
  const lastActive = await history.lastActive(swapTargets(full, minSwapKB), lookback, activeCpu);
  const now = Date.now();
  const coverage = lastActive ? history.coverage(now - lookback, now) : null;
  return swapView({ full, lastActive, coverage, now, minSwapKB, idleMs: SWAP_IDLE_MS, intervalMs: rec.intervalSec * 1000, activeCpu });
});

/** Cibles de kill des instances (ou lanceurs d'un groupe) d'après le dernier snapshot ; instances disparues absentes. */
ipcMain.handle('instances:targets', (_e, keys: unknown) => {
  if (!isInstanceKeys(keys)) throw new Error('Requête invalide');
  return last ? instanceTargets(last, keys) : [];
});

ipcMain.handle('history:system', (_e, r: unknown) => (isRange(r) ? history.system(r) : null));
ipcMain.handle('history:disk', (_e, r: unknown) => (isRange(r) ? history.disk(r) : null));
ipcMain.handle('history:groups', (_e, r: unknown, keys: unknown) => (isRange(r) && isGroupKeys(keys) ? history.groups(r, keys) : null));
ipcMain.handle('history:group', (_e, key: unknown, r: unknown) => (typeof key === 'string' && isRange(r) ? history.group(key, r) : null));
ipcMain.handle('history:procs', (_e, key: unknown, r: unknown) => (typeof key === 'string' && isRange(r) ? history.procs(key, r) : null));
ipcMain.handle('history:procTree', (_e, key: unknown, ts: unknown) => (isProcTreeRequest(key, ts) ? history.procTree(key as string, ts as number) : null));
ipcMain.handle('history:culprits', (_e, ts: unknown) => (Number.isFinite(ts) ? history.culprits(ts as number) : []));
ipcMain.handle('history:top', (_e, r: unknown, o: unknown) => (isRange(r) && isTopOptions(o) ? history.top(r, o) : { byAvg: [], byMax: [] }));
ipcMain.handle('history:events', (_e, r: unknown, groupKey: unknown) => (isRange(r) && isOptionalGroupKey(groupKey) ? history.events(r, groupKey) : []));
/**
 * /tmp, sauf racine de test : PROC_WATCH_TMP_ROOT n'est retenu que si son chemin réel est sous ~/.cache/pw-… et contient
 * le fichier témoin .computer-watcher-test-root (ou .proc-watch-test-root) (voir tmpRootFromEnv) ; ni NODE_ENV ni l'empaquetage n'entrent en compte.
 */
const tmpRootChoice = tmpRootFromEnv(process.env);
const tmpRoot = tmpRootChoice.root;
if (tmpRootChoice.warning) console.error(`${APP_DISPLAY_NAME} : ${tmpRootChoice.warning}`);
if (tmpRoot !== '/tmp') console.error(`${APP_DISPLAY_NAME} : racine /tmp de test : ${tmpRoot}`);
const tmpTopDirs = sharedScan(() => topTmpDirs(tmpRoot));
ipcMain.handle('tmp:topDirs', () => tmpTopDirs());
/** Tuiles de la page /tmp : taille et occupation (statfs), RAM totale ; lecture seule. */
ipcMain.handle('tmp:stats', () => tmpFsStats(tmpRoot));
const sizeText = (kb: number) =>
  kb >= 1024 * 1024 ? `${(kb / (1024 * 1024)).toFixed(1).replace('.', ',')} Go` : kb >= 1024 ? `${Math.round(kb / 1024)} Mo` : `${Math.round(kb)} Ko`;
/** Confirmation native dans le main : chemins exacts (échappés), taille totale, « Annuler » par défaut. */
const confirmTmpClean = async (s: TmpConfirmSummary): Promise<boolean> => {
  const t = confirmText(s, sizeText);
  const opts: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Supprimer de /tmp',
    message: t.message,
    detail: t.detail,
    buttons: ['Annuler', 'Supprimer définitivement'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
  return r.response === 1;
};
// original-fs : aucune réécriture des archives .asar par Electron ; la récursion est faite par GNU rm (voir tmpClean.ts)
// objets mis à l'écart après un échange : gardés par le main dans son dossier de données (0600), jamais dans la quarantaine
const tmpSetAside = createSetAsideStore(join(data, 'tmp-set-aside.json'));
const tmpCleaner = createTmpCleaner(tmpRoot, { fs: originalFsp as unknown as CleanFs, confirm: confirmTmpClean, setAside: tmpSetAside });
ipcMain.handle('tmp:entries', () => tmpCleaner.list());
/** Suppression : liste autorisée du main, confirmation native, revérification et suppression élément par élément. */
/** Journal : une suppression (même partielle) ajoute un événement tmp_clean. */
const logTmpClean = (outcome: TmpDeleteOutcome) => {
  const ev = tmpCleanEvent(outcome, Date.now());
  if (!ev) return;
  try {
    mkdirSync(data, { recursive: true });
    appendFileSync(appEventsPath(data), formatAppEvent(ev));
  } catch (e) {
    console.error('app event:', e);
  }
};
ipcMain.handle('tmp:delete', async (_e, raw: unknown) => {
  tmpTopDirs.reset(); // un parcours en cours décrirait l'état d'avant
  const outcome = await tmpCleaner.delete(raw);
  tmpTopDirs.reset();
  logTmpClean(outcome);
  return outcome;
});
/** « Vider la quarantaine » : restes de suppressions interrompues, confirmation native, même suppression par descripteur. */
ipcMain.handle('tmp:emptyQuarantine', async () => {
  tmpTopDirs.reset();
  const outcome = await tmpCleaner.emptyQuarantine();
  tmpTopDirs.reset();
  logTmpClean(outcome);
  return outcome;
});
// Page Disque : parcours du dossier personnel (soleil) dans un processus enfant à basse priorité, gardé 10 min.
const diskScans = createScanCache({ scan: (o, signal) => scanHome(homedir(), { ...o, signal }) });
ipcMain.handle('disk:scan', (e, force: unknown) =>
  diskScans.scan((kb) => {
    if (!e.sender.isDestroyed()) e.sender.send('disk:scan-progress', kb);
  }, { force: force === true }));
/** Page quittée : le parcours en cours est annulé 30 s plus tard, sauf retour d'ici là. */
ipcMain.handle('disk:scan-cancel', () => diskScans.leave());

// Familles récupérables : mesure du service (une fois par jour) ou de l'app (plus de 24 h, « Actualiser », après un ménage).
const DISK_FAMILIES_MAX_AGE_MS = 24 * 3600_000;
const diskRoots = () => familyRoots(process.env, homedir());
let diskMeasuring: Promise<FamiliesFile | null> | null = null;
const measureDiskFamilies = (): Promise<FamiliesFile | null> =>
  (diskMeasuring ??= (async () => {
    try {
      const at = Date.now();
      const f: FamiliesFile = { at, families: await measureFamilies(diskRoots()) };
      mkdirSync(data, { recursive: true, mode: 0o700 });
      writeFamiliesFile(diskFamiliesPath(data), f);
      return f;
    } catch (e) {
      console.error('disque: mesure des familles :', e);
      return readFamiliesFile(diskFamiliesPath(data));
    } finally {
      diskMeasuring = null;
    }
  })());
const diskMountinfo = () => readFileSync('/proc/self/mountinfo', 'utf8');
/** Dernières raisons de refus par famille (dernier ménage), montrées dans la liste. */
const diskLastRefusals = new Map<FamilyId, string>();
const diskFamiliesView = (f: FamiliesFile | null) => {
  const roots = diskRoots();
  // refus visibles sans parcourir les processus (lien, autre disque, montage, outil manquant) : case désactivée ;
  // refus du dernier ménage (utilisé par…) : seulement affichés, la famille reste cochable
  const refusals: Partial<Record<FamilyId, string>> = {};
  const lastRefusals: Partial<Record<FamilyId, string>> = {};
  for (const m of f?.families ?? []) {
    let why: string | null = null;
    try {
      why = staticRefusal(m.id, { roots, mountinfo: diskMountinfo });
    } catch (e) {
      why = `vérification impossible (${(e as Error).message})`;
    }
    if (why) refusals[m.id] = why;
    else if (diskLastRefusals.has(m.id)) lastRefusals[m.id] = diskLastRefusals.get(m.id)!;
  }
  // chemins des familles (affichage seulement : liens soleil ↔ familles ; la suppression les recalcule)
  const paths = Object.fromEntries((f?.families ?? []).filter((m) => !['pkg-cache', 'journal'].includes(m.id)).map((m) => [m.id, familyPaths(m.id, roots)]));
  return { file: f, refusals, lastRefusals, paths, home: roots.home, measuring: diskMeasuring !== null };
};
ipcMain.handle('disk:families', async (_e, force: unknown) => {
  const f = readFamiliesFile(diskFamiliesPath(data));
  const age = f ? Date.now() - f.at : Infinity;
  if (force === true || !f || !(age >= 0 && age < DISK_FAMILIES_MAX_AGE_MS)) return diskFamiliesView(await measureDiskFamilies());
  return diskFamiliesView(f);
});
/** Bandes de la page : chaque disque réel surveillé (statfs) et la place récupérable des familles qui s'y trouvent. */
ipcMain.handle('disk:partitions', () => {
  const mi = diskMountinfo();
  const parts = watchedPartitions(mi, (m) => {
    try {
      const st = statfsSync(m);
      return Math.round((st.blocks * st.bsize) / 1024);
    } catch {
      return null;
    }
  });
  const roots = diskRoots();
  // familles refusées d'avance (lien, outil manquant…) : pas comptées comme récupérables
  const fams = (readFamiliesFile(diskFamiliesPath(data))?.families ?? []).filter((m) => {
    try {
      return !staticRefusal(m.id, { roots, mountinfo: () => mi });
    } catch {
      return false;
    }
  });
  return parts.flatMap((p) => {
    try {
      const st = statfsSync(p.mount);
      const reclaimKB = fams.reduce((s, m) => (m.reclaimKB !== null && partitionOf(mi, familyPaths(m.id, roots)[0], parts)?.mount === p.mount ? s + m.reclaimKB : s), 0);
      return [{ mount: p.mount, sizeKB: Math.round((st.blocks * st.bsize) / 1024), availKB: Math.round((st.bavail * st.bsize) / 1024), reclaimKB }];
    } catch {
      return [];
    }
  });
});
/** « Ouvrir dans le gestionnaire de fichiers » : dossier réel sous HOME seulement. */
ipcMain.handle('disk:open', (_e, path: unknown) => openInFileManager(path, { home: homedir() }));
/** Confirmation native du ménage : récapitulatif par famille, « Annuler » par défaut. */
const confirmDiskClean = async (s: { message: string; detail: string }): Promise<boolean> => {
  const opts: Electron.MessageBoxOptions = {
    type: 'warning', title: 'Libérer de l’espace disque', message: s.message, detail: s.detail,
    buttons: ['Annuler', 'Supprimer définitivement'], defaultId: 0, cancelId: 0, noLink: true,
  };
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
  return r.response === 1;
};
// pkexec d'un script figé ; PROC_WATCH_DISK_ROOT_FAKE=1 (hors paquet seulement) : rien n'est lancé (bout en bout)
const diskRoot = diskRootRunner(process.env, app.isPackaged);
if (diskRoot.fake) console.error(`${APP_DISPLAY_NAME} : actions administrateur du disque simulées (PROC_WATCH_DISK_ROOT_FAKE)`);
const diskRunRoot: CleanDeps['runRoot'] = (action) => runDiskRoot(action, diskRoot.run);
let diskCleaning = false;
ipcMain.handle('disk:clean', async (e, raw: unknown): Promise<CleanResult> => {
  if (!isFamilyRequest(raw)) throw new Error('requête refusée : familles inconnues ou en double');
  if (diskCleaning) throw new Error('un ménage est déjà en cours');
  diskCleaning = true;
  try {
    const sizes = Object.fromEntries((readFamiliesFile(diskFamiliesPath(data))?.families ?? []).map((m) => [m.id, m.reclaimKB]));
    const r = await cleanFamilies(raw, {
      roots: diskRoots(), confirm: confirmDiskClean, sizes, mountinfo: diskMountinfo, runRoot: diskRunRoot, pathSizes: defaultDu,
      // étape en cours (« Mesure des tailles… » sur le bouton)
      onPhase: (phase) => {
        if (!e.sender.isDestroyed()) e.sender.send('disk:clean-phase', phase);
      },
      dirUser: (dir) => realDirUser(dir, { selfExes: ownAppImageExes() }),
      procByName: (names) => realProcByName(names),
      statfs: (p) => {
        const st = statfsSync(p);
        return { availKB: Math.round((st.bavail * st.bsize) / 1024) };
      },
    });
    for (const id of raw) diskLastRefusals.delete(id);
    for (const x of r.refused) diskLastRefusals.set(x.id, x.reason);
    const ev = diskCleanEvent(r, Date.now());
    if (ev) {
      try {
        mkdirSync(data, { recursive: true });
        appendFileSync(appEventsPath(data), formatAppEvent(ev));
      } catch (e) {
        console.error('app event:', e);
      }
    }
    if (r.done.length) {
      diskScans.clear();
      void measureDiskFamilies();
    }
    return r;
  } finally {
    diskCleaning = false;
  }
});

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
/** Un seul script root earlyoom à la fois : « Appliquer », installation et activation partagent ce verrou. */
const earlyoomLock: EarlyoomLock = { held: false };
const applyEarlyoomIpc = createEarlyoomApplier(() => config.protected, confirmEarlyoomLine, undefined, earlyoomLock);
ipcMain.handle('earlyoom:apply', (_e, s: unknown, expectedLine: unknown) => applyEarlyoomIpc(s, expectedLine));

// B8 bis : pop-up du lancement (une fois par lancement : « Plus tard » est gardé en mémoire par le main), installation / activation.
let earlyoomLater = false;
ipcMain.handle('earlyoom:reminder', async () => {
  const status = await earlyoomStatus();
  return { mode: reminderMode({ status, snoozedAt: config.earlyoomReminder?.snoozedAt, later: earlyoomLater, now: Date.now() }), status };
});
ipcMain.handle('earlyoom:remindLater', (_e, kind: unknown): ConfigState => {
  if (kind === 'later') earlyoomLater = true;
  else if (kind === 'week') {
    const next = snoozeReminder(config, Date.now());
    saveConfig(dir, next);
    config = next;
    earlyoomLater = true;
  } else throw new Error('Valeur invalide');
  return configState();
});
const earlyoomSetupIpc = createEarlyoomSetup({
  status: () => earlyoomStatus(),
  getProtected: () => config.protected,
  exists: existsSync,
  readOsRelease: () => {
    try {
      return readFileSync(OS_RELEASE, 'utf8');
    } catch {
      return null;
    }
  },
  lock: earlyoomLock,
  confirm: async ({ mode, pm, line }) => {
    const c = setupConfirmation(mode, pm, line);
    const opts: Electron.MessageBoxOptions = {
      type: 'warning', title: 'earlyoom', message: c.message, detail: c.detail, buttons: ['Annuler', c.confirm], defaultId: 0, cancelId: 0, noLink: true,
    };
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
    return r.response === 1;
  },
  log: (e) => {
    try {
      mkdirSync(data, { recursive: true });
      appendFileSync(appEventsPath(data), formatAppEvent(e));
    } catch (err) {
      console.error('app event:', err);
    }
  },
});
ipcMain.handle('earlyoom:setup', async (_e, mode: unknown) => {
  const r = await earlyoomSetupIpc(mode);
  if (r.ok) earlyoomLater = true; // réglé : plus de pop-up dans ce lancement
  return r;
});

ipcMain.handle('desktop:install', () => {
  if (!app.isPackaged) throw new Error('Disponible uniquement dans la version installée (AppImage ou .deb)');
  return installDesktopEntry(ownImage ?? process.execPath, process.env, undefined, appIcon);
});

// ---------------------------------------------------------------- installation comme une app, accueil, désinstallation
// Racines injectables (HOME, XDG_CONFIG_HOME, XDG_DATA_HOME) : une app de test aux dossiers temporaires ne touche rien d'autre.
const roots = rootsFrom(process.env, homedir());
const paths = appPaths(roots);
/** AppImage réellement lancée (voir ownImage / realAppImage), sinon null. */
const appImage = ownImage;
const onboardingFile = join(dir, 'onboarding.json');
const readOnboarding = (): OnboardingFile | null => {
  try {
    return parseOnboardingFile(readFileSync(onboardingFile, 'utf8'));
  } catch {
    return null;
  }
};
const writeOnboarding = (f: OnboardingFile) => writeFileSafe([roots.configHome], onboardingFile, serializeOnboarding(f), 0o600);
const onboardingAtLaunch = readOnboarding();
let onboardingOpen = primary && shouldOpenOnboarding({ file: onboardingAtLaunch, freshConfig });
const isFile = (p: string) => {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
};

/** Confirmation native (« Annuler » par défaut). */
async function confirmNative(o: { title: string; message: string; detail: string; confirm: string }): Promise<boolean> {
  const opts: Electron.MessageBoxOptions = {
    type: 'warning', title: o.title, message: o.message, detail: o.detail, buttons: ['Annuler', o.confirm], defaultId: 0, cancelId: 0, noLink: true,
  };
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
  return r.response === 1;
}

ipcMain.handle('onboarding:get', async (): Promise<OnboardingInfo> => {
  const steps = onboardingSteps(appImage !== null);
  const destReal = await realpath(paths.appImage).catch(() => null);
  const srcReal = appImage ? await realpath(appImage).catch(() => null) : null;
  return {
    open: onboardingOpen,
    steps,
    start: startIndex(steps, onboardingAtLaunch?.resume),
    appImage,
    dest: paths.appImage,
    installed: isFile(paths.appImage),
    runningFromCopy: !!destReal && destReal === srcReal,
    dataDir: data,
    ...(originalDeletion ? { originalDeletion } : {}),
  };
});
/** Terminé ou « Passer » : ne revient plus au lancement (rouvrable depuis Réglages › À propos). */
ipcMain.handle('onboarding:finish', () => {
  onboardingOpen = false;
  writeOnboarding({ version: 1, done: true });
});
ipcMain.handle('onboarding:install', async () => {
  if (!appImage) throw new Error('Pas une AppImage : rien à installer (paquet .deb ou version de développement)');
  return installAppImage({ source: appImage, roots, iconPng: appIcon });
});
/**
 * Relance depuis la copie installée, puis quitte. La copie est d'abord revérifiée (fichier ordinaire, exécutable, même
 * SHA-256 que l'AppImage lancée). Avec `deleteOriginal` (case cochée) et après une confirmation native qui montre le
 * chemin, le consentement (chemin + SHA-256) est passé à la copie relancée, qui supprime l'original elle-même après
 * revérification : l'original n'est jamais supprimé avant que la copie ait démarré.
 */
ipcMain.handle('onboarding:relaunch', async (_e, del: unknown): Promise<{ relaunched: boolean }> => {
  if (!appImage) throw new Error('Pas une AppImage : rien à relancer');
  const [src, copy] = await Promise.all([hashNoFollow(appImage), hashNoFollow(paths.appImage).catch(() => null)]);
  if (!copy) throw new Error(`Copie introuvable ou pas un fichier ordinaire : ${paths.appImage} (installer d'abord)`);
  if (copy.sha256 !== src.sha256) throw new Error(`${paths.appImage} ne correspond pas à l’AppImage lancée : réinstaller`);
  if (!(await access(paths.appImage, fsConstants.X_OK).then(() => true, () => false))) throw new Error(`${paths.appImage} n’est pas exécutable (dossier monté en noexec ?)`);
  let consent: OnboardingFile['deleteOriginal'];
  if (del === true) {
    const ok = await confirmNative({
      title: 'Supprimer le fichier téléchargé',
      message: 'Supprimer le fichier téléchargé d’origine ?',
      detail: `${appImage}\n\nIl sera supprimé par la copie relancée, seulement s’il n’a pas changé.\nLa copie installée reste : ${paths.appImage}`,
      confirm: 'Relancer et supprimer',
    });
    if (!ok) return { relaunched: false };
    // accord transmis par onboarding.json (0600, dossier ouvert sans suivre de lien), jamais par la ligne de commande
    consent = { path: appImage, sha256: src.sha256, ino: src.ino, expires: Date.now() + DELETE_CONSENT_TTL_MS };
  }
  const steps = onboardingSteps(true);
  writeOnboarding({ version: 1, done: false, resume: steps[steps.indexOf('install') + 1], ...(consent ? { deleteOriginal: consent } : {}) });
  // Processus détaché, pas app.relaunch : son assistant de relance s'exécute depuis le montage de l'AppImage en cours,
  // démonté quand elle quitte (vérifié avec une vraie AppImage : la copie ne démarrait jamais). On ne quitte qu'une fois
  // la copie démarrée (n-1) ; sinon l'app reste ouverte et l'erreur s'affiche dans l'accueil.
  quitting = true;
  await new Promise<void>((resolve, reject) =>
    relaunchDetached({
      ...relaunchHooks(),
      target: paths.appImage,
      onStarted: () => {
        setTimeout(() => app.quit(), 50);
        resolve();
      },
      onFailed: (m) => {
        quitting = false;
        reject(new Error(`Copie installée, mais pas relancée : ${m}. Lancer ${APP_DISPLAY_NAME} depuis le menu.`));
      },
    }),
  );
  return { relaunched: true };
});

/**
 * Accord reçu de l'instance précédente par onboarding.json : lu et effacé une seule fois (le fichier est réécrit sans lui
 * avant toute suppression), refusé s'il a expiré ; traité seulement dans la copie installée. La ligne de commande
 * (anciens --delete-original=…) est ignorée.
 */
let originalDeletion: { path: string; ok: boolean; message: string } | null = null;
async function deletePendingOriginal(): Promise<void> {
  const taken = takeDeleteConsent(readOnboarding(), Date.now());
  if (!taken.consent && !taken.error) return;
  const path = taken.consent?.path ?? readOnboarding()?.deleteOriginal?.path ?? '';
  try {
    writeOnboarding(taken.rest!); // usage unique : effacé avant d'agir
  } catch (e) {
    originalDeletion = { path, ok: false, message: `accord non effacé (${e instanceof Error ? e.message : String(e)}) : rien supprimé` };
    return;
  }
  if (!taken.consent) {
    originalDeletion = { path, ok: false, message: taken.error! };
    return;
  }
  const c = taken.consent;
  try {
    // même fichier que la copie installée (dev+ino), pas seulement le même chemin réel
    const here = appImage ? await stat(appImage).catch(() => null) : null;
    const copy = await stat(paths.appImage).catch(() => null);
    if (!here || !copy || here.dev !== copy.dev || here.ino !== copy.ino) throw new Error(`${APP_DISPLAY_NAME} ne tourne pas depuis la copie installée : rien supprimé`);
    await verifyAndDeleteOriginal({ path: c.path, sha256: c.sha256, ino: c.ino, copy: paths.appImage });
    originalDeletion = { path: c.path, ok: true, message: '' };
  } catch (e) {
    originalDeletion = { path: c.path, ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

const autostartInfo = (): AutostartInfo => {
  const s = autostartState(roots);
  return { enabled: s.enabled, path: s.path, target: launchTarget({ roots, appImage: appImage ?? undefined, packaged: app.isPackaged, execPath: process.execPath }) };
};
ipcMain.handle('autostart:get', () => autostartInfo());
ipcMain.handle('autostart:set', (_e, on: unknown) => {
  if (typeof on !== 'boolean') throw new Error('Valeur invalide');
  setAutostart(on, autostartInfo().target, roots);
  return autostartInfo();
});

ipcMain.handle('about:info', (): AboutInfo => ({
  version: app.getVersion(),
  appImage,
  installedCopy: isFile(paths.appImage) ? paths.appImage : null,
  packaged: app.isPackaged,
  migration: currentMigration(),
}));

/** Bilan affiché : celui de ce lancement, sinon l'état enregistré (migration faite lors d'un lancement précédent). */
const currentMigration = (): MigrationReport => (migration.status === 'nothing' ? migrationState(migrationDeps()) : migration);
ipcMain.handle('migration:state', () => currentMigration());
/**
 * « Réessayer » : les étapes d'après l'ouverture des dossiers (service, entrées, copie) sont refaites tout de suite ; l'arrêt
 * de l'ancien service et le déplacement des dossiers, jamais sous les pieds de l'app : elle redémarre et les refait avant
 * d'ouvrir quoi que ce soit.
 */
ipcMain.handle('migration:retry', async (): Promise<{ report: MigrationReport; relaunching: boolean }> => {
  const now = currentMigration();
  const early = now.status === 'deferred' || !now.done.includes('stop-legacy-service') && !now.skipped['stop-legacy-service'] || !now.done.includes('move-dirs');
  if (early) {
    quitting = true;
    // la nouvelle instance attend que celle-ci ait réellement quitté avant de toucher aux dossiers
    process.env.PROC_WATCH_WAIT_PID = String(process.pid);
    if (appImage) {
      await new Promise<void>((resolve, reject) =>
        relaunchDetached({
          ...relaunchHooks(),
          target: appImage!,
          onStarted: () => {
            setTimeout(() => app.quit(), 50);
            resolve();
          },
          onFailed: (m) => {
            quitting = false;
            delete process.env.PROC_WATCH_WAIT_PID;
            reject(new Error(`relance impossible : ${m}`));
          },
        }),
      );
    } else {
      process.env.PROC_WATCH_RELAUNCH = '1'; // la nouvelle instance réessaie le verrou le temps que celle-ci quitte
      app.relaunch();
      setTimeout(() => app.quit(), 50);
    }
    return { report: now, relaunching: true };
  }
  const late = await migrateLate(migrationDeps());
  if (late.status !== 'nothing') migration = late;
  return { report: currentMigration(), relaunching: false };
});

const isDeb = () => app.isPackaged && !appImage;
ipcMain.handle('uninstall:plan', (_e, o: unknown) => {
  if (!isUninstallOptions(o)) throw new Error('Requête invalide');
  const plan = uninstallPlan(roots, o);
  return { items: plan, ...uninstallSummary(plan, { deb: isDeb() }) };
});
/** Le main refait le plan (jamais de chemins venus du renderer), le montre dans une confirmation native, puis l'exécute. */
ipcMain.handle('uninstall:run', async (_e, o: unknown) => {
  if (!isUninstallOptions(o)) throw new Error('Requête invalide');
  const plan = uninstallPlan(roots, o);
  const s = uninstallSummary(plan, { deb: isDeb() });
  if (!(await confirmNative({ title: `Désinstaller ${APP_DISPLAY_NAME}`, message: s.message, detail: s.detail, confirm: 'Désinstaller' }))) return { cancelled: true as const };
  uninstalling = true;
  await syncing.catch(() => {}); // pas de synchronisation du service en cours
  let stopped = false;
  const result = await runUninstall(plan, roots, {
    service: {
      stop: async (unitPath) => {
        // échoue fermé : erreur ou `keep` (PROC_WATCH_NO_RECORDER_SYNC) → unité et AppImage gardées
        const r = await stopRecorderForUninstall({ unitPath, run: defaultSystemctl, disabled: recorderSyncDisabled() });
        stopped = r.stopped;
        return r;
      },
      reload: async () => {
        if (stopped) await defaultSystemctl(['daemon-reload']);
      },
    },
    beforeHistory: () => history.close(),
  });
  if (result.done) {
    quitting = true;
    // le renderer affiche le résultat, puis l'app quitte sans arrêt « propre » de Chromium (qui réécrirait son profil) ;
    // configuration cochée : dernier passage juste avant (vérifié avec une vraie AppImage : Session Storage revenait)
    // dernier passage sur la configuration, puis sortie immédiate ; Chromium recrée quand même « Session Storage » en
    // quittant (vérifié avec une vraie AppImage) : un /bin/sh détaché le retire une fois le processus terminé
    setTimeout(() => {
      const sweep = o.config ? runUninstall(configSweepPlan(roots), roots, { service: { stop: async () => null, reload: async () => {} } }) : Promise.resolve();
      void sweep.catch(() => {}).finally(() => {
        if (o.config) {
          try {
            // chemin réel relevé maintenant (jamais un lien) ; outils absolus et environnement fixe (I-A, M-1)
            // (le dossier vient souvent d'être retiré par le dernier passage : chemin réel du parent + nom fixe)
            const tools = sweepTools(existsSync);
            const l = lstatSync(paths.configDir, { throwIfNoEntry: false });
            const parentReal = (() => {
              try {
                return realpathSync(dirname(paths.configDir));
              } catch {
                return null;
              }
            })();
            if (tools && parentReal && (!l || l.isDirectory())) {
              const c = postExitSweepCommand(process.pid, join(parentReal, basename(paths.configDir)), tools);
              spawn(c.cmd, c.args, { detached: true, stdio: 'ignore', env: c.env }).unref();
            }
          } catch (e) {
            console.error('désinstallation :', e);
          }
        }
        app.exit(0);
      });
    }, 2500);
  }
  return { cancelled: false as const, result };
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
  // Pendant une installation de mise à jour, la nouvelle version peut démarrer avant que celle-ci ait fini de quitter.
  if (quitting) return;
  const action = secondInstanceAction(argv);
  if (action === 'free') openFree();
  else if (action === 'show') showWindow();
  const id = alertIdFromArgv(argv);
  if (id !== null) alertOpener.open(id);
});

// Mises à jour : AppImage empaquetée → proposition puis installation sur demande ; .deb → notification seulement ;
// sources → rien (sauf PROC_WATCH_UPDATE_FEED vers un flux de test local). Réglages dans updater.json.
const updatePrefs = createPrefsStore(join(dir, 'updater.json'));
// Copie installée (~/Applications/computer-watcher.AppImage) présente mais pas lancée : l'original n'est pas mis à jour.
const updMode = updateMode({ isPackaged: app.isPackaged, appImage: ownImage, testFeed: updateFeed, installedElsewhere: !!ownImage && installedElsewhere(ownImage, homedir()) });
let updateBackend: Promise<UpdateBackend> | null = null;
const loadUpdateBackend = (): Promise<UpdateBackend> =>
  (updateBackend ??=
    updMode === 'install'
      ? createAppImageBackend({
          testFeed: updateFeed,
          testConfigPath: join(app.getPath('userData'), 'test-app-update.yml'),
          appImage: ownImage!,
          // I-C : relance par nous, détachée, environnement nettoyé (jamais par electron-updater), puis sortie
          restart: (target) => {
            quitting = true;
            relaunchDetached({
              ...relaunchHooks(),
              target,
              onStarted: () => setImmediate(() => app.quit()),
              // n-1 : rien n'a démarré : l'app reste ouverte, verrou repris, chemin affiché
              onFailed: (m) => {
                quitting = false;
                void dialog.showMessageBox({
                  type: 'warning',
                  title: APP_DISPLAY_NAME,
                  message: `Mise à jour installée ; relance ${APP_DISPLAY_NAME} depuis le menu.`,
                  detail: m,
                  buttons: ['OK'],
                  noLink: true,
                });
              },
            });
          },
        })
      : Promise.resolve(createReleasesApiBackend({ url: updateFeed ? `${updateFeed}releases.json` : RELEASES_API_URL, fetch })));
let installBackend: UpdateBackend | null = null;
const updater = createUpdateController({
  mode: updMode,
  current: app.getVersion(),
  backend:
    updMode === 'off'
      ? null
      : {
          check: async (pre) => (await loadUpdateBackend()).check(pre),
          download: async (onProgress) => {
            const b = await loadUpdateBackend();
            if (!b.download) throw new Error('Téléchargement indisponible');
            installBackend = b;
            await b.download(onProgress);
          },
          pendingFile: () => installBackend?.pendingFile?.() ?? null,
          install: () => {
            if (!installBackend?.install) throw new Error('Installation indisponible');
            quitting = true;
            try {
              installBackend.install();
            } catch (e) {
              quitting = false; // installation échouée : l'app reste ouverte et fonctionne normalement
              throw e;
            }
          },
        },
  loadPrefs: () => updatePrefs.load(),
  savePrefs: (p) => updatePrefs.save(p),
  send: (v) => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('update:view', v);
  },
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  setInterval: (fn, ms) => setInterval(fn, ms),
});
ipcMain.handle('update:get', () => updater.view());
ipcMain.handle('update:check', async () => {
  await updater.check(true);
  return updater.view();
});
ipcMain.handle('update:download', () => {
  void updater.download();
  return updater.view();
});
ipcMain.handle('update:install', () => updater.install());
ipcMain.handle('update:retry', () => {
  void updater.retry();
  return updater.view();
});
ipcMain.handle('update:later', () => {
  updater.later();
  return updater.view();
});
ipcMain.handle('update:ignore', () => {
  updater.ignore();
  return updater.view();
});
ipcMain.handle('update:setPrefs', (_e, raw: unknown) => updater.setPrefs(raw));
ipcMain.handle('update:openRelease', (_e, url: unknown) => {
  if (!isReleaseUrl(url)) throw new Error('Adresse refusée');
  return shell.openExternal(url);
});

/**
 * Nouvelle version depuis le lancement précédent (mise à jour) : le service est relancé (nouveau code), puis la version est
 * mémorisée, seulement si la synchronisation a abouti (sinon nouvel essai au prochain lancement). Sources : jamais.
 */
async function syncAfterUpdate(): Promise<void> {
  const version = app.getVersion();
  const changed = app.isPackaged && updatePrefs.load().lastRunVersion !== version;
  const ok = await syncRecorder(false, changed);
  if (!changed || !ok) return;
  try {
    updatePrefs.save({ ...updatePrefs.load(), lastRunVersion: version });
  } catch (e) {
    console.error('updater:', e);
  }
}

app.whenReady().then(async () => {
  if (!primary) return;
  // Migration proc-watch → computer-watcher, second temps (avant la synchronisation du service ci-dessous)
  if (migration.status === 'partial' || migration.status === 'done') {
    try {
      const late = await migrateLate(migrationDeps());
      if (late.status !== 'nothing') migration = late;
    } catch (e) {
      console.error('migration :', e);
    }
    if (quitting) return; // relancée depuis computer-watcher.AppImage : cette instance s'arrête
  }
  if (migration.status === 'partial' || (migration.status === 'deferred' && !xdgDeferred())) {
    const [message, ...detail] = migrationLines(migration);
    void dialog.showMessageBox({ type: 'warning', title: APP_DISPLAY_NAME, message, detail: `${detail.join('\n')}\n\nRéglages › À propos : « Réessayer ».`, buttons: ['OK'], noLink: true });
  }
  // `--hidden` (démarrage avec la session) : fenêtre cachée, puis dans la barre des tâches si l'icône existe, sinon réduite.
  const shown = startWindowShown(process.argv);
  await deletePendingOriginal(); // avant la fenêtre : l'accueil repris montre le résultat
  createWindow(shown);
  // Après une mise à jour de l'AppImage, le fichier a souvent un nouveau nom : l'unité du service (ExecStart) est réécrite
  // par la synchronisation (copie installée, sinon AppImage vérifiée), et relancée même si elle est identique (nouveau code).
  void syncAfterUpdate();
  if (app.isPackaged && ownImage) {
    try {
      refreshDesktopEntry(ownImage);
    } catch (e) {
      console.error('desktop entry:', e);
    }
  }
  const tray = syncTray();
  updater.start();
  if (shown) return;
  await tray;
  if (mainWin && !mainWin.isDestroyed() && !mainWin.isVisible() && hiddenPlacement(trayCtl?.active() === true) === 'minimized') {
    mainWin.showInactive();
    mainWin.minimize();
  }
});
app.on('window-all-closed', () => app.quit());
