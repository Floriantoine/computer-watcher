// scripts/recorder-e2e.mjs — lance le vrai service 12 s sur des dossiers temporaires
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

const electron = createRequire(import.meta.url)('electron');
const base = mkdtempSync(join(tmpdir(), 'pw-e2e-'));
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'cfg') };
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
  db.close();
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
