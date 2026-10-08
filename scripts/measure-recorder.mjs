// scripts/measure-recorder.mjs — CPU et PSS du vrai service d'enregistrement, sans règle ou avec les modèles en Simulation.
// Usage : node scripts/measure-recorder.mjs --rules none|templates   (après `npm run build`)
// Sécurité : dossiers XDG temporaires, faux notify-send en tête du PATH, PROC_WATCH_NO_KILL=1 et règles en Simulation
// seulement ; le service est toujours arrêté à la fin. Vérifie qu'aucun rule_action n'a été écrit.
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const mode = process.argv.includes('--rules') ? process.argv[process.argv.indexOf('--rules') + 1] : 'none';
if (mode !== 'none' && mode !== 'templates') {
  console.error('usage : measure-recorder.mjs --rules none|templates');
  process.exit(2);
}
const WARMUP_S = Number(process.env.MEASURE_WARMUP_S ?? 20);
const SAMPLE_S = Number(process.env.MEASURE_SAMPLE_S ?? 120);
const CLK_TCK = 100;

const electron = createRequire(import.meta.url)('electron');
const base = mkdtempSync(join(tmpdir(), 'pw-measure-rec-'));
const fakeBin = join(base, 'bin');
mkdirSync(fakeBin);
writeFileSync(join(fakeBin, 'notify-send'), `#!/bin/sh\nif [ "$1" = "--help" ]; then echo '  -A, --action=[NAME=]Text'; exit 0; fi\nexit 0\n`);
chmodSync(join(fakeBin, 'notify-send'), 0o755);

// Modèles fournis (Front/Back inactifs, vitest, prévision) activés EN SIMULATION, plus une règle mémoire « node-MainThread > 100 Mo » (nom réel des processus node récents)
// par instance qui se déclenche réellement en simulation sur une machine de développement.
const sim = (id, name, condition) => ({ id, name, enabled: true, mode: 'simulate', createdAt: 0, condition });
const rules = mode === 'none'
  ? { enabled: false, list: [] }
  : {
      enabled: true,
      list: [
        sim('t-vitest', 'vitest > 4 Go pendant 5 min', { kind: 'memory', target: 'instance', match: { by: 'name', value: 'vitest' }, overMB: 4096, forMin: 5 }),
        sim('t-inactive', 'Front/Back de projet inactif depuis 1 j', { kind: 'inactive', categories: ['front', 'back'], forHours: 24 }),
        sim('t-forecast', 'Épuisement prévu dans < 3 min', { kind: 'forecast', underMin: 3, includeApps: [] }),
        sim('m-node', 'node > 100 Mo', { kind: 'memory', target: 'group', match: { by: 'name', value: 'node-MainThread' }, overMB: 100, forMin: 1 }),
      ],
    };
if (rules.list.some((r) => r.mode !== 'simulate')) throw new Error('mesure : règles en Simulation seulement');
mkdirSync(join(base, 'cfg', 'proc-watch'), { recursive: true });
writeFileSync(
  join(base, 'cfg', 'proc-watch', 'config.json'),
  JSON.stringify({ version: 1, protected: [], othersThreshold: { memMB: 100, cpuPercent: 1 }, rules }),
);
const env = {
  ...process.env, ELECTRON_RUN_AS_NODE: '1', PROC_WATCH_NO_KILL: '1',
  XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'cfg'), PATH: `${fakeBin}:${process.env.PATH}`,
};
const child = spawn(electron, ['out/main/recorder.js'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', (b) => (stderr += b));
const exited = new Promise((r) => child.on('exit', r));
const cpuTicks = () => {
  const f = readFileSync(`/proc/${child.pid}/stat`, 'utf8');
  const rest = f.slice(f.lastIndexOf(')') + 2).split(' ');
  return Number(rest[11]) + Number(rest[12]);
};
let result;
try {
  await new Promise((r) => setTimeout(r, WARMUP_S * 1000));
  const t0 = cpuTicks();
  const w0 = Date.now();
  await new Promise((r) => setTimeout(r, SAMPLE_S * 1000));
  const t1 = cpuTicks();
  const w1 = Date.now();
  const pss = Number((readFileSync(`/proc/${child.pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)/m) ?? [0, 0])[1]);
  result = { rules: mode, cpuPercent: Math.round(((t1 - t0) / CLK_TCK / ((w1 - w0) / 1000)) * 100 * 100) / 100, pssMB: Math.round(pss / 1024) };
} finally {
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  await exited;
  clearTimeout(timer);
}
let code = 0;
try {
  const db = new DatabaseSync(join(base, 'data', 'proc-watch', 'metrics.db'), { readOnly: true });
  const count = (t) => db.prepare('SELECT COUNT(*) n FROM events WHERE type = ?').get(t).n;
  result.ruleDryRuns = count('rule_dry_run');
  result.ruleActions = count('rule_action');
  db.close();
  const status = JSON.parse(readFileSync(join(base, 'data', 'proc-watch', 'recorder-status.json'), 'utf8'));
  result.jobErrors = status.jobErrors;
  console.log(JSON.stringify(result));
  if (result.ruleActions !== 0) {
    console.error('rule_action écrit pendant une mesure en Simulation');
    code = 1;
  }
  if (/NO_KILL|NOKILL/.test(stderr)) console.error('tentative de kill bloquée par PROC_WATCH_NO_KILL (inattendu en Simulation)');
  if (process.env.MEASURE_VERBOSE) console.error(stderr.split('\n').slice(-20).join('\n'));
} finally {
  rmSync(base, { recursive: true, force: true });
}
process.exit(code);
