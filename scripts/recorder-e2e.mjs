// scripts/recorder-e2e.mjs — lance le vrai service 12 s sur des dossiers temporaires
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

const electron = createRequire(import.meta.url)('electron');
const base = mkdtempSync(join(tmpdir(), 'pw-e2e-'));
// Faux notify-send en tête du PATH : aucune vraie notification du bureau pendant la vérification ; il note ses arguments.
const fakeBin = join(base, 'bin');
const calls = join(base, 'notify-calls');
mkdirSync(fakeBin);
writeFileSync(
  join(fakeBin, 'notify-send'),
  `#!/bin/sh\nif [ "$1" = "--help" ]; then echo '  -A, --action=[NAME=]Text'; exit 0; fi\nfor a in "$@"; do printf '%s\\n' "$a"; done >> '${calls}'\necho --- >> '${calls}'\n`,
);
chmodSync(join(fakeBin, 'notify-send'), 0o755);
// Seuil « fichiers en mémoire » au minimum (100 Mo) : l'alerte tmpfs part au premier tick sur une machine normale.
mkdirSync(join(base, 'cfg', 'proc-watch'), { recursive: true });
writeFileSync(
  join(base, 'cfg', 'proc-watch', 'config.json'),
  JSON.stringify({
    version: 1, protected: [], othersThreshold: { memMB: 100, cpuPercent: 1 },
    recorder: { enabled: true, intervalSec: 5, detailHours: 24, summaryDays: 30, procMinMemMB: 50, procMinCpuPercent: 1, groupMinMemMB: 20, leakMinMinutes: 60, leakMinGrowthMB: 300, tmpfsAlertMB: 100 },
  }),
);
const env = {
  ...process.env, ELECTRON_RUN_AS_NODE: '1', XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'cfg'), PATH: `${fakeBin}:${process.env.PATH}`,
};
const child = spawn(electron, ['out/main/recorder.js'], { env, stdio: ['ignore', 'inherit', 'inherit'] });
child.on('error', (e) => {
  console.error(`spawn: ${e.message}`);
  rmSync(base, { recursive: true, force: true });
  process.exit(1);
});
let pss = 0;
const exited = new Promise((r) => child.on('exit', r));
try {
  await new Promise((r) => setTimeout(r, 12_000));
  pss = Number((readFileSync(`/proc/${child.pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)/m) ?? [0, 0])[1]);
} finally {
  // le service ne doit jamais rester en vie, même si le script échoue
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  await exited;
  clearTimeout(timer);
}
let code = 0;
try {
  const db = new DatabaseSync(join(base, 'data', 'proc-watch', 'metrics.db'), { readOnly: true });
  const samples = db.prepare('SELECT COUNT(*) n FROM system_samples').get().n;
  const groups = db.prepare('SELECT COUNT(*) n FROM groups').get().n;
  const tmpfs = db.prepare("SELECT id FROM events WHERE type = 'tmpfs'").all();
  db.close();
  // une alerte tmpfs (canal « both » par défaut) → exactement une notification, avec « Ouvrir » si l'app est construite
  const sent = existsSync(calls) ? readFileSync(calls, 'utf8').split('---\n').filter(Boolean).map((c) => c.trim().split('\n')) : [];
  console.log(JSON.stringify({ tmpfsEvents: tmpfs.length, notifications: sent }));
  if (tmpfs.length > 0 && (sent.length !== 1 || !sent[0].includes('--app-name=proc-watch') || !sent[0].includes('--urgency=critical'))) {
    console.error('notification du bureau attendue pour l’alerte tmpfs');
    code = 1;
  }
  const status = JSON.parse(readFileSync(join(base, 'data', 'proc-watch', 'recorder-status.json'), 'utf8'));
  console.log(JSON.stringify({ samples, groups, pssMB: Math.round(pss / 1024), status }));
  if (samples < 2 || groups < 5 || status.lastError) code = 1;
  if (pss / 1024 > 60) {
    console.error(`PSS trop élevée : ${Math.round(pss / 1024)} Mo`);
    code = 1;
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}
process.exit(code);
