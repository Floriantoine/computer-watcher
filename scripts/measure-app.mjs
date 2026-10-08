// Mesure mémoire (PSS) et CPU de l'app buildée : `npm run build && node scripts/measure-app.mjs [dossier…]`.
// Lance l'app directement (pas de Playwright : son instrumentation CDP du renderer fausserait la mesure) avec un
// XDG_CONFIG_HOME temporaire, attend la stabilisation, échantillonne chaque processus de l'arbre Electron, fenêtre
// visible puis réduite, affiche un tableau par type et ferme l'app. Les actions sur la fenêtre (minimize, focus…)
// passent par l'inspecteur Node du seul processus main (--inspect), qui ne touche pas au renderer.
// Scénarios : visible (fenêtre considérée active : un événement focus est émis toutes les 10 s, comme un utilisateur
// présent), background (blur puis 62 s d'attente : rythme de fond), minimized (win.minimize()), hidden (win.hide()).
// Affichage : par défaut chaque app tourne dans son propre KWin imbriqué virtuel (kwin_wayland --virtual, bus D-Bus et config à part) :
// la fenêtre est réellement affichée et active quel que soit l'état du bureau (écran verrouillé, autre bureau…), et
// rien n'apparaît à l'écran. MEASURE_KWIN=0 : utiliser la session courante.
// Variables : MEASURE_SETTLE_S (20), MEASURE_SAMPLE_S (60), MEASURE_SCENARIOS (« visible,minimized »),
// MEASURE_MAXIMIZE (1 : fenêtre agrandie, plus de cartes à l'écran), MEASURE_OTHERS_OPEN (1 : carte « Autres » dépliée),
// MEASURE_ROUTE (metrics : onglet Métriques ouvert après la stabilisation, panneau « Ports ouverts » compris),
// MEASURE_QUERY (texte tapé dans la recherche de la page Processus après la stabilisation, ex. « :3000 »),
// MEASURE_QUERIES (« q1|q2 » : une recherche par app, dans l'ordre des dossiers).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

const electronPath = createRequire(import.meta.url)('electron');

/** KWin virtuel imbriqué ; renvoie le nom de son socket Wayland et de quoi l'arrêter. */
async function startKwin(n) {
  const socket = `pw-measure-${process.pid}-${n}`;
  const cfg = mkdtempSync(join(tmpdir(), 'pw-kwin-'));
  const child = spawn('dbus-run-session', ['--', 'kwin_wayland', '--virtual', '--no-lockscreen', '--socket', socket, '--width', '1600', '--height', '1000'], {
    env: { ...process.env, XDG_CONFIG_HOME: cfg },
    stdio: 'ignore',
    detached: true, // groupe de processus à part : arrêté d'un coup à la fin
  });
  const path = join(process.env.XDG_RUNTIME_DIR ?? '/run/user/1000', socket);
  for (let i = 0; i < 100 && !existsSync(path); i++) await sleep(100);
  if (!existsSync(path)) throw new Error('kwin_wayland --virtual n\'a pas démarré');
  return {
    socket,
    stop: async () => {
      // Tout le groupe (dbus-run-session, dbus-daemon, kwin_wayland, Xwayland éventuel) ; SIGKILL s'il traîne.
      const alive = () => readdirSync('/proc').some((e) => /^\d+$/.test(e) && Number((read(`/proc/${e}/stat`) ?? '').split(') ')[1]?.split(' ')[2]) === child.pid);
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
      for (let i = 0; i < 50 && alive(); i++) await sleep(100);
      if (alive())
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      rmSync(cfg, { recursive: true, force: true });
    },
  };
}

/** Lance une app (`dossier`, `dossier:reduced` pour « Effets visuels réduits », `dossier:pss` pour « Mémoire : PSS ») et se connecte à l'inspecteur de son main. */
async function launch(spec, kwin) {
  const [dir, variant] = spec.split(':');
  const cfg = mkdtempSync(join(tmpdir(), 'pw-measure-'));
  if (variant === 'reduced' || variant === 'pss') {
    mkdirSync(join(cfg, 'proc-watch'));
    const ui = variant === 'pss' ? { reducedEffects: false, memoryMetric: 'pss' } : { reducedEffects: true };
    const config = { version: 1, protected: [], othersThreshold: { memMB: 100, cpuPercent: 1 }, ui };
    writeFileSync(join(cfg, 'proc-watch', 'config.json'), JSON.stringify(config));
  }
  // PROC_WATCH_NO_RECORDER_SYNC : l'app mesurée ne touche pas au service systemd réel de l'utilisateur.
  const env = { ...process.env, XDG_CONFIG_HOME: cfg, PROC_WATCH_NO_RECORDER_SYNC: '1' };
  if (kwin) {
    env.WAYLAND_DISPLAY = kwin.socket;
    delete env.DISPLAY;
  }
  const child = spawn(electronPath, ['--inspect=127.0.0.1:0', dir], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const url = await new Promise((resolve, reject) => {
    let err = '';
    const t = setTimeout(() => reject(new Error(`pas d'inspecteur : ${err}`)), 20000);
    child.stderr.on('data', (d) => {
      err += d;
      const m = /ws:\/\/[^\s]+/.exec(err);
      if (m) {
        clearTimeout(t);
        resolve(m[0]);
      }
    });
  });
  const ws = new WebSocket(url);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (waiting.has(msg.id)) waiting.get(msg.id)(msg);
  };
  /** Évalue `expr` dans le processus main (`win` = la fenêtre). */
  const evaluate = (expr) =>
    new Promise((resolve) => {
      const n = ++id;
      waiting.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression: `(() => { const win = process.mainModule.require('electron').BrowserWindow.getAllWindows()[0]; return ${expr}; })()`, returnByValue: true } }));
    });
  // Attendre la fenêtre et son renderer.
  for (let i = 0; i < 100; i++) {
    const r = await evaluate('!!win && !win.webContents.isLoading()');
    if (r.result?.result?.value) break;
    await sleep(200);
  }
  return { dir: spec, cfg, child, ws, evaluate };
}

// Dossiers d'app à mesurer (défaut : celui-ci ; suffixe :reduced = effets réduits, :pss = mémoire en PSS). Plusieurs : mesurés en même temps (A/B).
const dirs = process.argv.slice(2).length ? process.argv.slice(2) : ['.'];
const apps = [];
// Un KWin par app : chaque fenêtre est entièrement visible (des fenêtres superposées ne seraient pas toutes redessinées).
const kwins = [];
try {
  for (const [i, dir] of dirs.entries()) {
    const kwin = process.env.MEASURE_KWIN === '0' ? null : await startKwin(i);
    if (kwin) kwins.push(kwin);
    apps.push(await launch(dir, kwin));
  }
  const roots = apps.map((a) => a.child.pid);
  console.log(`apps ${apps.map((a, i) => `${a.dir} (PID ${roots[i]}, ${tree(roots[i]).length} processus)`).join(', ')} ; stabilisation ${SETTLE_S} s, échantillonnage ${SAMPLE_S} s`);
  const onAll = (expr) => Promise.all(apps.map((a) => a.evaluate(expr)));
  if (process.env.MEASURE_MAXIMIZE) await onAll('win.maximize()');
  // « Autres » dépliée : état mémorisé du renderer, pris en compte au rechargement.
  if (process.env.MEASURE_OTHERS_OPEN === '1')
    await onAll("win.webContents.executeJavaScript(\"localStorage.setItem('pw.othersOpen','1'); location.reload()\")");
  await sleep(SETTLE_S * 1000);
  const ROUTE = process.env.MEASURE_ROUTE ?? 'main';
  // MEASURE_QUERIES (« q1|q2 ») : une recherche par app, dans l'ordre des dossiers (comparer deux recherches qui affichent les mêmes cartes).
  const queries = process.env.MEASURE_QUERIES ? process.env.MEASURE_QUERIES.split('|') : process.env.MEASURE_QUERY ? apps.map(() => process.env.MEASURE_QUERY) : null;
  if (queries) {
    // Champ contrôlé par React : setter natif puis événement input.
    const js = (q) => `(() => { const i = document.querySelector('.search input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(q)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
    await Promise.all(apps.map((a, i) => a.evaluate(`win.webContents.executeJavaScript(${JSON.stringify(js(queries[i] ?? ''))})`)));
  }
  if (ROUTE === 'metrics') {
    const js = `(() => { const b = [...document.querySelectorAll('button, a, [role=tab]')].find((e) => e.textContent.trim().startsWith('Métriques')); b?.click(); return !!b; })()`;
    await onAll(`win.webContents.executeJavaScript(${JSON.stringify(js)})`);
  }
  if (ROUTE !== 'main' || queries) await sleep(5000);
  const page = ROUTE === 'metrics' ? 'onglet Métriques' : queries ? `page Processus, recherche « ${queries.join(' » / « ')} »` : 'page Processus';
  for (const sc of SCENARIOS) {
    if (sc === 'minimized') await onAll('win.minimize()');
    if (sc === 'hidden') await onAll('win.hide()');
    if (sc === 'minimized' || sc === 'hidden') await sleep(3000);
    if (sc === 'background') {
      await onAll("win.emit('blur')");
      await sleep(62_000);
    }
    let keepFocus = null;
    if (sc === 'visible') {
      await onAll("win.emit('focus')");
      keepFocus = setInterval(() => void onAll("win.emit('focus')").catch(() => {}), 10_000);
    }
    const label = { visible: 'visible', background: 'visible sans focus', minimized: 'réduite', hidden: 'cachée' }[sc] ?? sc;
    const results = await sample(roots, SAMPLE_S);
    if (keepFocus) clearInterval(keepFocus);
    results.forEach((rows, i) => print(`Fenêtre ${label} (${page})${apps.length > 1 ? ` — ${apps[i].dir}` : ''}`, rows));
  }
} finally {
  for (const { child, ws, cfg } of apps) {
    ws.close();
    child.kill('SIGTERM');
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    rmSync(cfg, { recursive: true, force: true });
  }
  for (const kwin of kwins) await kwin.stop();
}
