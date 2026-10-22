// src/recorder/index.ts
import { mkdirSync, statSync, watch } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promises as originalFsp } from 'original-fs';
import { configDir } from '../core/config';
import { dataDir } from '../core/paths';
import { emptyTmpCaches, measureTmpCaches, type CachesFs } from '../core/tmpCachesClean';
import { tmpRootFromEnv } from '../main/tmpClean';
import { antigelDepsFor } from './antigelDeps';
import { fridgeDepsFor } from './fridgeDeps';
import { followEarlyoom } from './journal';
import { appLauncher, appLaunchCommand, launchApp } from './launchApp';
import { createNotifier, resolveBin } from './notify';
import { createRecorder } from './recorder';
import { serviceKill } from './ruleRunner';

// Bouton « Ouvrir » des notifications : lanceur de l'app déduit de l'emplacement du service (voir launchApp.ts).
const launcher = appLauncher({
  appImage: process.env.APPIMAGE,
  execPath: process.execPath,
  recorderScript: process.argv[1],
  uid: process.getuid?.() ?? 0,
  isFile: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
});
const systemdRun = resolveBin('systemd-run', process.env.PATH);
// Bouton « Vider les caches (X) » des notifications tmpfs : /tmp, sauf racine de test (mêmes règles que l'app) ;
// original-fs : aucune réécriture des archives .asar.
const tmpRoot = tmpRootFromEnv(process.env).root;
const cachesFs = originalFsp as unknown as CachesFs;
const rec = createRecorder({
  dataDir: dataDir(),
  configDir: configDir(),
  notifier: createNotifier(),
  launchApp: launcher ? (args) => launchApp(appLaunchCommand(launcher, args, systemdRun)) : undefined,
  // Règles actives : seul endroit où un vrai signal peut partir (PROC_WATCH_NO_KILL=1 : aucun).
  kill: serviceKill(),
  // out/main/recorder.js → dossier de l'app (jamais visé par une règle)
  appRoot: process.argv[1] ? resolve(dirname(process.argv[1]), '..', '..') : null,
  // Anti-gel : vrais appels systemd (gestionnaire utilisateur) ; PROC_WATCH_NO_ANTIGEL=1 : aucun.
  antigel: antigelDepsFor({ env: process.env, uid: process.getuid?.() ?? -1, selfPid: process.pid, dataDir: dataDir() }),
  // Anti-gel lot 3 (« mettre au frigo ») : gel / réveil d'un projet demandé par la fenêtre ; PROC_WATCH_NO_ANTIGEL=1 : rien.
  fridge: fridgeDepsFor({ env: process.env, uid: process.getuid?.() ?? -1, selfPid: process.pid }),
  tmpCaches: { measure: () => measureTmpCaches(tmpRoot, { fs: cachesFs }), empty: (ids) => emptyTmpCaches(tmpRoot, ids, { fs: cachesFs }) },
});
rec.start();

// Anti-gel : racine de travail encore trop jeune pour être rangée → passe anti-gel seule une seconde plus tard, sans
// attendre le tick suivant (la mémoire allouée avant le déplacement reste comptée hors budget). Rien en régime normal.
let recheck: NodeJS.Timeout | undefined;
const scheduleRecheck = () => {
  clearTimeout(recheck);
  const ms = rec.antigelRecheckMs();
  if (ms === null || ms >= rec.config().intervalSec * 1000) return;
  recheck = setTimeout(() => {
    rec.antigelPass();
    scheduleRecheck();
  }, ms);
};
const tick = () => {
  rec.tick();
  scheduleRecheck();
};
let timer: NodeJS.Timeout;
const schedule = () => {
  clearInterval(timer);
  timer = setInterval(tick, rec.config().intervalSec * 1000);
};
tick();
schedule();
const minute = setInterval(() => rec.minuteJob(), 60_000);

const stopJournal = followEarlyoom((l) => rec.onEarlyoomLine(l), (s) => rec.setEarlyoomSource(s));

let debounce: NodeJS.Timeout | undefined;
try {
  mkdirSync(configDir(), { recursive: true });
  const watcher = watch(configDir(), () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      try {
        const before = rec.config().intervalSec;
        rec.reloadConfig();
        if (rec.config().intervalSec !== before) schedule();
      } catch (e) {
        console.error(`config: ${(e as Error).message}`);
      }
    }, 500);
  });
  watcher.on('error', (e) => console.error(`config watch: ${e.message}`));
} catch {
  // dossier de config inaccessible : la config par défaut reste active
}

const shutdown = () => {
  clearInterval(timer);
  clearTimeout(recheck);
  clearInterval(minute);
  stopJournal();
  rec.stop();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
