// src/recorder/index.ts
import { mkdirSync, statSync, watch } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { configDir } from '../core/config';
import { dataDir } from '../core/paths';
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
});
rec.start();

let timer: NodeJS.Timeout;
const schedule = () => {
  clearInterval(timer);
  timer = setInterval(() => rec.tick(), rec.config().intervalSec * 1000);
};
rec.tick();
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
  clearInterval(minute);
  stopJournal();
  rec.stop();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
