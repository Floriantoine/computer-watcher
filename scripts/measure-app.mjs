// Mesure mémoire (PSS) et CPU de l'app buildée : `npm run build && node scripts/measure-app.mjs`.
// Lance l'app via Playwright avec un XDG_CONFIG_HOME temporaire, attend la stabilisation, échantillonne
// chaque processus de l'arbre Electron, fenêtre visible puis réduite, affiche un tableau par type et ferme l'app.
// Variables : MEASURE_SETTLE_S (20), MEASURE_SAMPLE_S (60), MEASURE_SCENARIOS (« visible,minimized »).
import { _electron as electron } from 'playwright';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SETTLE_S = Number(process.env.MEASURE_SETTLE_S ?? 20);
const SAMPLE_S = Number(process.env.MEASURE_SAMPLE_S ?? 60);
const SCENARIOS = (process.env.MEASURE_SCENARIOS ?? 'visible,minimized').split(',');
const CLK_TCK = 100;
const PSS_EVERY_MS = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};

function statOf(pid) {
  const s = read(`/proc/${pid}/stat`);
  if (!s) return null;
  const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
  return { ppid: Number(f[1]), ticks: Number(f[11]) + Number(f[12]) };
}

/** Tous les descendants de `root` (lui compris). */
function tree(root) {
  const parent = new Map();
  for (const e of readdirSync('/proc')) {
    if (!/^\d+$/.test(e)) continue;
    const st = statOf(e);
    if (st) parent.set(Number(e), st.ppid);
  }
  const out = [root];
  for (let i = 0; i < out.length; i++) for (const [pid, pp] of parent) if (pp === out[i]) out.push(pid);
  return out;
}

function kindOf(pid) {
  // Chromium réécrit la ligne de commande de ses enfants en une seule chaîne séparée par des espaces.
  const cmd = (read(`/proc/${pid}/cmdline`) ?? '').split(/[\0 ]/);
  const t = cmd.find((a) => a.startsWith('--type='));
  if (!t) return cmd[0]?.includes('electron') ? 'main' : 'autre';
  const type = t.slice(7);
  if (type === 'utility' || type === 'zygote') return 'utility + zygotes';
  return type;
}

function pssKB(pid) {
  const m = /^Pss:\s+(\d+)/m.exec(read(`/proc/${pid}/smaps_rollup`) ?? '');
  return m ? Number(m[1]) : 0;
}

async function sample(root, seconds) {
  const kinds = new Map();
  const t0 = new Map();
  for (const pid of tree(root)) {
    const st = statOf(pid);
    if (st) t0.set(pid, st.ticks);
  }
  const pss = new Map(); // kind -> somme des PSS échantillonnés
  let rounds = 0;
  const start = Date.now();
  while (Date.now() - start < seconds * 1000) {
    rounds++;
    const byKind = new Map();
    for (const pid of tree(root)) {
      if (!kinds.has(pid)) kinds.set(pid, kindOf(pid));
      const k = kinds.get(pid);
      byKind.set(k, (byKind.get(k) ?? 0) + pssKB(pid));
    }
    for (const [k, v] of byKind) pss.set(k, (pss.get(k) ?? 0) + v);
    await sleep(Math.min(PSS_EVERY_MS, seconds * 1000 - (Date.now() - start)));
  }
  const elapsed = (Date.now() - start) / 1000;
  const cpu = new Map();
  for (const pid of tree(root)) {
    const st = statOf(pid);
    if (!st) continue;
    if (!kinds.has(pid)) kinds.set(pid, kindOf(pid));
    const k = kinds.get(pid);
    cpu.set(k, (cpu.get(k) ?? 0) + (st.ticks - (t0.get(pid) ?? 0)));
  }
  const rows = [...new Set([...pss.keys(), ...cpu.keys()])].map((k) => ({
    kind: k,
    pssMB: (pss.get(k) ?? 0) / rounds / 1024,
    cpu: ((cpu.get(k) ?? 0) / CLK_TCK / elapsed) * 100,
  }));
  rows.sort((a, b) => b.pssMB - a.pssMB);
  return rows;
}

function print(title, rows) {
  const total = rows.reduce((s, r) => ({ pssMB: s.pssMB + r.pssMB, cpu: s.cpu + r.cpu }), { pssMB: 0, cpu: 0 });
  console.log(`\n### ${title}\n`);
  console.log('| Processus | PSS moyen | CPU moyen |');
  console.log('|---|---|---|');
  for (const r of rows) console.log(`| ${r.kind} | ${r.pssMB.toFixed(0)} Mo | ${r.cpu.toFixed(2)} % |`);
  console.log(`| **total** | **${total.pssMB.toFixed(0)} Mo** | **${total.cpu.toFixed(2)} %** |`);
}

const cfg = mkdtempSync(join(tmpdir(), 'pw-measure-'));
const app = await electron.launch({ args: ['.'], env: { ...process.env, XDG_CONFIG_HOME: cfg } });
try {
  const root = app.process().pid;
  const win = await app.firstWindow();
  await win.waitForSelector('[data-testid="snapshot-ready"]', { timeout: 20000 });
  console.log(`app PID ${root}, ${tree(root).length} processus ; stabilisation ${SETTLE_S} s, échantillonnage ${SAMPLE_S} s`);
  await sleep(SETTLE_S * 1000);
  for (const sc of SCENARIOS) {
    if (sc === 'minimized') {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
      await sleep(3000);
    } else if (sc === 'hidden') {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
      await sleep(3000);
    }
    print(`Fenêtre ${sc === 'visible' ? 'visible' : sc === 'minimized' ? 'réduite' : 'cachée'} (page Processus)`, await sample(root, SAMPLE_S));
  }
} finally {
  await app.close().catch(() => {});
  rmSync(cfg, { recursive: true, force: true });
}
