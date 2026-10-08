// src/recorder/index.ts
import { mkdirSync, statSync, watch } from 'node:fs';
import { configDir } from '../core/config';
import { dataDir } from '../core/paths';
import { followEarlyoom } from './journal';
import { appLauncher, appLaunchCommand, launchApp } from './launchApp';
import { createNotifier, resolveBin } from './notify';
import { createRecorder } from './recorder';

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
