// scripts/recorder-e2e.mjs — lance le vrai service 12 s sur des dossiers temporaires
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

const electron = createRequire(import.meta.url)('electron');
// sous ~/.cache (disque) : /tmp est en RAM, un arrêt brutal y laisserait la base et les journaux
mkdirSync(join(homedir(), '.cache'), { recursive: true });
const base = mkdtempSync(join(homedir(), '.cache', 'pw-e2e-'));
// Faux notify-send en tête du PATH : aucune vraie notification du bureau pendant la vérification ; il note ses arguments
// et « clique » sur « Vider les caches » quand la notification le propose.
const fakeBin = join(base, 'bin');
const calls = join(base, 'notify-calls');
mkdirSync(fakeBin);
writeFileSync(
  join(fakeBin, 'notify-send'),
  `#!/bin/sh\nif [ "$1" = "--help" ]; then echo '  -A, --action=[NAME=]Text'; exit 0; fi\nfor a in "$@"; do printf '%s\\n' "$a"; done >> '${calls}'\necho --- >> '${calls}'\ncase "$*" in *--action=empty-caches=*) echo empty-caches ;; esac\n`,
);
// /tmp factice (racine de test : sous ~/.cache/pw-…, avec son fichier témoin) : un faux cache Jest de 101 Mo, vidé par
// le service quand le faux notify-send clique ; jamais le vrai /tmp.
const tmpRoot = join(base, 'tmproot');
const jestCache = join(tmpRoot, `jest_${process.getuid().toString(36)}`);
mkdirSync(join(jestCache, 'jest-transform-cache-x', '0f'), { recursive: true });
writeFileSync(join(tmpRoot, '.computer-watcher-test-root'), '');
writeFileSync(join(jestCache, 'jest-transform-cache-x', '0f', 'mod_0f'), Buffer.alloc(101 * 1024 * 1024, 1));
writeFileSync(join(jestCache, 'haste-map-x'), Buffer.alloc(64 * 1024, 1));
chmodSync(join(fakeBin, 'notify-send'), 0o755);
// Seuil « fichiers en mémoire » au minimum (100 Mo) : l'alerte tmpfs part au premier tick sur une machine normale.
mkdirSync(join(base, 'cfg', 'computer-watcher'), { recursive: true });
writeFileSync(
  join(base, 'cfg', 'computer-watcher', 'config.json'),
  JSON.stringify({
    version: 1, protected: [], othersThreshold: { memMB: 100, cpuPercent: 1 },
    recorder: { enabled: true, intervalSec: 5, detailHours: 24, summaryDays: 30, procMinMemMB: 50, procMinCpuPercent: 1, groupMinMemMB: 20, leakMinMinutes: 60, leakMinGrowthMB: 300, tmpfsAlertMB: 100 },
  }),
);
// Le service lancé ici lit le vrai /proc : jamais d'anti-gel (PROC_WATCH_NO_ANTIGEL=1 : aucun busctl, aucun processus
// déplacé) ni de signal (PROC_WATCH_NO_KILL=1 : les règles recommandées sont actives par défaut).
const env = {
  ...process.env, ELECTRON_RUN_AS_NODE: '1', PROC_WATCH_NO_ANTIGEL: '1', PROC_WATCH_NO_KILL: '1',
  XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'cfg'), PATH: `${fakeBin}:${process.env.PATH}`,
  PROC_WATCH_TMP_ROOT: tmpRoot,
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
  const db = new DatabaseSync(join(base, 'data', 'computer-watcher', 'metrics.db'), { readOnly: true });
  const samples = db.prepare('SELECT COUNT(*) n FROM system_samples').get().n;
  const groups = db.prepare('SELECT COUNT(*) n FROM groups').get().n;
  const tmpfs = db.prepare("SELECT id FROM events WHERE type = 'tmpfs'").all();
  const tmpClean = db.prepare("SELECT detail FROM events WHERE type = 'tmp_clean'").all();
  db.close();
  // une alerte tmpfs (canal « both » par défaut) → une notification critique avec « Vider le cache Jest (101 Mo) » ; le
  // faux notify-send clique : le service vide le cache (fichiers supprimés, dossiers gardés), note un tmp_clean et
  // envoie une seconde notification, le résultat
  const sent = existsSync(calls) ? readFileSync(calls, 'utf8').split('---\n').filter(Boolean).map((c) => c.trim().split('\n')) : [];
  console.log(JSON.stringify({ tmpfsEvents: tmpfs.length, notifications: sent, tmpClean }));
  const left = readdirSync(jestCache, { recursive: true, withFileTypes: true }).filter((e) => !e.isDirectory()).map((e) => e.name);
  if (tmpfs.length > 0) {
    if (sent.length !== 2 || !sent[0].includes('--app-name=Computer Watcher') || !sent[0].includes('--urgency=critical') || !sent[0].includes('--action=empty-caches=Vider le cache Jest (101 Mo)')) {
      console.error('notification tmpfs attendue, avec « Vider le cache Jest (101 Mo) »');
      code = 1;
    } else if (!sent[1].includes('--urgency=normal') || !sent[1].includes('Cache Jest vidé : 101 Mo libérés')) {
      console.error('notification du résultat du vidage attendue');
      code = 1;
    }
    if (left.length || !existsSync(join(jestCache, 'jest-transform-cache-x', '0f')) || tmpClean.length !== 1) {
      console.error(`cache Jest factice : fichiers restants ${JSON.stringify(left)}, dossiers gardés attendus, un tmp_clean attendu`);
      code = 1;
    }
  }
  const status = JSON.parse(readFileSync(join(base, 'data', 'computer-watcher', 'recorder-status.json'), 'utf8'));
  console.log(JSON.stringify({ samples, groups, pssMB: Math.round(pss / 1024), status }));
  if (samples < 2 || groups < 5 || status.lastError) code = 1;
  if (pss / 1024 > 60) {
    console.error(`PSS trop élevée : ${Math.round(pss / 1024)} Mo`);
    code = 1;
  }
  // anti-gel coupé : aucun état écrit (donc aucun appel systemd)
  if (existsSync(join(base, 'data', 'computer-watcher', 'antigel-state.json'))) {
    console.error('anti-gel actif dans le service de vérification (PROC_WATCH_NO_ANTIGEL=1 attendu)');
    code = 1;
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}
process.exit(code);
