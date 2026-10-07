// src/recorder/index.ts
import { watch } from 'node:fs';
import { configDir } from '../core/config';
import { dataDir } from '../core/paths';
import { followEarlyoom } from './journal';
import { createRecorder } from './recorder';

const rec = createRecorder({ dataDir: dataDir(), configDir: configDir() });
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
  watch(configDir(), () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const before = rec.config().intervalSec;
      rec.reloadConfig();
      if (rec.config().intervalSec !== before) schedule();
    }, 500);
  });
} catch {
  // dossier de config absent : la config par défaut reste active
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
