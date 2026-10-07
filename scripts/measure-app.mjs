// Mesure mémoire (PSS) et CPU de l'app buildée : `npm run build && node scripts/measure-app.mjs [dossier…]`.
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

/** Échantillonne en parallèle plusieurs arbres Electron : mêmes conditions système pour chacun. */
async function sample(roots, seconds) {
  const kinds = new Map();
  const kindOfCached = (pid) => {
    if (!kinds.has(pid)) kinds.set(pid, kindOf(pid));
    return kinds.get(pid);
  };
  const t0 = new Map();
  for (const root of roots)
    for (const pid of tree(root)) {
      const st = statOf(pid);
      if (st) t0.set(pid, st.ticks);
    }
  const pss = roots.map(() => new Map()); // kind -> somme des PSS échantillonnés
  let rounds = 0;
  const start = Date.now();
  while (Date.now() - start < seconds * 1000) {
    rounds++;
    roots.forEach((root, i) => {
      for (const pid of tree(root)) {
        const k = kindOfCached(pid);
        pss[i].set(k, (pss[i].get(k) ?? 0) + pssKB(pid));
      }
    });
    await sleep(Math.min(PSS_EVERY_MS, seconds * 1000 - (Date.now() - start)));
  }
  const elapsed = (Date.now() - start) / 1000;
  return roots.map((root, i) => {
    const cpu = new Map();
    for (const pid of tree(root)) {
      const st = statOf(pid);
      if (!st) continue;
      const k = kindOfCached(pid);
      cpu.set(k, (cpu.get(k) ?? 0) + (st.ticks - (t0.get(pid) ?? 0)));
    }
    const rows = [...new Set([...pss[i].keys(), ...cpu.keys()])].map((k) => ({
      kind: k,
      pssMB: (pss[i].get(k) ?? 0) / rounds / 1024,
      cpu: ((cpu.get(k) ?? 0) / CLK_TCK / elapsed) * 100,
    }));
    rows.sort((a, b) => b.pssMB - a.pssMB);
    return rows;
  });
}

function print(title, rows) {
  const total = rows.reduce((s, r) => ({ pssMB: s.pssMB + r.pssMB, cpu: s.cpu + r.cpu }), { pssMB: 0, cpu: 0 });
  console.log(`\n### ${title}\n`);
  console.log('| Processus | PSS moyen | CPU moyen |');
  console.log('|---|---|---|');
  for (const r of rows) console.log(`| ${r.kind} | ${r.pssMB.toFixed(0)} Mo | ${r.cpu.toFixed(2)} % |`);
  console.log(`| **total** | **${total.pssMB.toFixed(0)} Mo** | **${total.cpu.toFixed(2)} %** |`);
}

// Dossiers d'app à mesurer (défaut : celui-ci). Plusieurs dossiers : lancés et mesurés en même temps (comparaison A/B).
const dirs = process.argv.slice(2).length ? process.argv.slice(2) : ['.'];
const apps = [];
try {
  for (const dir of dirs) {
    const cfg = mkdtempSync(join(tmpdir(), 'pw-measure-'));
    const app = await electron.launch({ args: [dir], env: { ...process.env, XDG_CONFIG_HOME: cfg } });
    apps.push({ dir, cfg, app });
    const win = await app.firstWindow();
    await win.waitForSelector('[data-testid="snapshot-ready"]', { timeout: 20000 });
  }
  const roots = apps.map((a) => a.app.process().pid);
  console.log(`apps ${apps.map((a, i) => `${a.dir} (PID ${roots[i]}, ${tree(roots[i]).length} processus)`).join(', ')} ; stabilisation ${SETTLE_S} s, échantillonnage ${SAMPLE_S} s`);
  await sleep(SETTLE_S * 1000);
  for (const sc of SCENARIOS) {
    const action = sc === 'minimized' ? 'minimize' : sc === 'hidden' ? 'hide' : null;
    if (action) {
      for (const { app } of apps) await app.evaluate(({ BrowserWindow }, a) => BrowserWindow.getAllWindows()[0][a](), action);
      await sleep(3000);
    }
    const label = sc === 'visible' ? 'visible' : sc === 'minimized' ? 'réduite' : 'cachée';
    const results = await sample(roots, SAMPLE_S);
    results.forEach((rows, i) => print(`Fenêtre ${label} (page Processus)${apps.length > 1 ? ` — ${apps[i].dir}` : ''}`, rows));
  }
} finally {
  for (const { app, cfg } of apps) {
    await app.close().catch(() => {});
    rmSync(cfg, { recursive: true, force: true });
  }
}
