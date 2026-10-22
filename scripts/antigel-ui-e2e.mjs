// Plafond de travail (anti-gel), fenêtre de bout en bout. Usage : npm run test:antigel-ui
//
// État du service SIMULÉ : ce script écrit lui-même antigel-state.json (le main ne fait que le lire ; aucun busctl, aucun
// appel systemd nulle part). HOME et XDG temporaires sous ~/.cache/pw-antigel-ui-* (jamais la vraie config ni la vraie
// metrics.db), PROC_WATCH_NO_RECORDER_SYNC=1 (service d'enregistrement réel laissé tranquille), PROC_WATCH_NO_KILL=1,
// PROC_WATCH_NO_ANTIGEL=1, earlyoom simulé (PROC_WATCH_EARLYOOM_FAKE). Seul processus créé : un node inactif à nous, dans
// un faux projet « alpha ». Il est détaché (double fork) : sinon, lancé sous Claude, il suivrait `npm run` dans la carte du
// dépôt (règle « lancé par Claude » du regroupement). Il s'arrête seul (toutes les 300 ms) dès que ce script n'existe plus
// (même PID et même heure de démarrage dans /proc), que le dossier temporaire disparaît ou que le fichier `.stop` du faux projet
// apparaît ; à la fin, le script pose `.stop` et attend sa sortie, sans aucun signal (pas de pkill). Aucun
// bouton Tuer ni confirmation n'est cliqué (la carte est ouverte par son libellé). Captures seulement si ANTIGEL_SHOTS
// désigne un dossier (hors du dépôt).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

mkdirSync(join(homedir(), '.cache'), { recursive: true });
const base = realpathSync(mkdtempSync(join(homedir(), '.cache', 'pw-antigel-ui-')));
let app = null;
let timer = null;
const cleanup = () => {
  clearInterval(timer);
  // le dossier temporaire disparu, le node du faux projet s'arrête seul (aucun signal envoyé)
  rmSync(base, { recursive: true, force: true });
};
// interruption : fermer l'app (2 s au plus), puis nettoyer
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, async () => {
    await Promise.race([app?.close().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
    cleanup();
    process.exit(130);
  });
}
const waitFor = async (fn, what, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`délai dépassé : ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};
try {
  const home = join(base, 'home');
  const cfg = join(base, 'cfg');
  const data = join(base, 'data');
  const proj = join(home, 'projets', 'alpha');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 'package.json'), '{"name":"alpha"}\n');
  mkdirSync(join(cfg, 'computer-watcher'), { recursive: true });
  writeFileSync(join(cfg, 'computer-watcher', 'onboarding.json'), '{"version":1,"done":true}\n');
  const dataApp = join(data, 'computer-watcher');
  mkdirSync(dataApp, { recursive: true });
  // double fork : l'intermédiaire lance le node inactif (détaché), écrit son PID et se termine. « Script vivant » = même PID
  // et même heure de démarrage (champ 22 de /proc/<pid>/stat) : un PID réutilisé n'est pas pris pour ce script.
  const startOf = (pid) => {
    const st = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return st.slice(st.lastIndexOf(')') + 2).split(' ')[19];
  };
  const self = { pid: process.pid, start: startOf(process.pid) };
  const idle = `const fs = require('node:fs'); const MARQUE = 'pw-antigel-ui-idle'; const self = ${JSON.stringify(self)};
const startOf = (pid) => { const st = fs.readFileSync(\`/proc/\${pid}/stat\`, 'utf8'); return st.slice(st.lastIndexOf(')') + 2).split(' ')[19]; };
const alive = () => { try { return startOf(self.pid) === self.start; } catch { return false; } };
setInterval(() => { if (!alive() || !fs.existsSync('package.json') || fs.existsSync('.stop')) process.exit(0); }, 300);`;
  const spawnIdle = `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(idle)}], { detached: true, stdio: 'ignore' }); process.stdout.write(String(c.pid)); c.unref();`;
  const launcher = spawn(process.execPath, ['-e', spawnIdle], { cwd: proj, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  launcher.stdout.on('data', (b) => { out += b; });
  await new Promise((r) => launcher.once('exit', r));
  const idlePid = Number(out);
  assert.ok(Number.isInteger(idlePid) && idlePid > 1, `PID du node inactif : ${out}`);
  // marque dans sa ligne de commande : un PID réutilisé par un autre processus n'est pas pris pour lui
  const idleAlive = () => {
    try {
      return readFileSync(`/proc/${idlePid}/cmdline`, 'utf8').includes('pw-antigel-ui-idle');
    } catch {
      return false;
    }
  };
  assert.ok(idleAlive(), 'node inactif lancé');

  // état simulé : `unit` = slice de projet (amendement A1), racine = le faux projet
  const G = 1024 * 1024; // Go en Ko
  const unit = 'cwatch-p-alpha.slice';
  let over = {};
  const state = () => ({
    version: 1, at: Date.now(), enabled: true, status: 'active', reason: null, memTotalKB: 32 * G, reserveKB: 5 * G,
    slice: { currentKB: 9 * G, highKB: 9 * G, maxKB: 29 * G, swapMaxKB: 10 * G, throttles: 3, oomKills: 1, throttled: true, stallPct: 42 },
    projects: [{ unit, root: proj, procs: 1, currentKB: 2 * G, budgetMB: null, throttled: true }],
    slices: { [unit]: proj }, lastError: null, tickMs: 0.4, dbusCalls: 2,
    // bureau prioritaire (lot 2) : poids posés, protection mémoire sans effet ici
    desk: { status: 'active', reason: null, cpu: true, io: false, memory: 'ineffective', units: ['session.slice', 'app.slice', 'app-dev.warp.Warp@1.service', 'cwatch.slice'], truncated: false, restoring: 0 },
    ...over,
  });
  const writeState = () => {
    const p = join(dataApp, 'antigel-state.json');
    writeFileSync(`${p}.tmp`, JSON.stringify(state()), { mode: 0o600 });
    renameSync(`${p}.tmp`, p);
  };
  writeState();
  timer = setInterval(writeState, 1000);
  const config = () => {
    try {
      return JSON.parse(readFileSync(join(cfg, 'computer-watcher', 'config.json'), 'utf8'));
    } catch {
      return {};
    }
  };

  const env = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: data, XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(base, 'state'),
    PROC_WATCH_NO_RECORDER_SYNC: '1', PROC_WATCH_NO_KILL: '1', PROC_WATCH_NO_ANTIGEL: '1', PROC_WATCH_EARLYOOM_FAKE: join(base, 'earlyoom'),
  };
  mkdirSync(env.PROC_WATCH_EARLYOOM_FAKE);
  app = await electron.launch({ args: ['.'], env });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1280, height: 900 }).catch(() => {});
  await win.waitForSelector('[data-testid="snapshot-ready"]', { timeout: 20000 });
  const shots = process.env.ANTIGEL_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  // fenêtre entière hors de l'onglet Processus ; là, la carte du faux projet seule (jamais les groupes réels)
  const shot = async (name, el = win) => { if (shots) await el.screenshot({ path: join(shots, `${name}.png`) }); };

  // 1) Processus : la carte du projet porte le badge « ralenti »
  // carte du faux projet par son libellé exact (racine ~/projets/alpha du HOME temporaire)
  const card = win.locator('[data-testid="group-card"]').filter({ has: win.locator('.card-title .label', { hasText: /^projets \/ alpha$/ }) });
  await card.waitFor({ timeout: 30000 });
  assert.equal(await card.count(), 1, 'une seule carte « projets / alpha »');
  const badge = card.locator('[data-testid="antigel-badge"]');
  await badge.waitFor();
  assert.match(await badge.innerText(), /ralenti/);
  assert.equal(await badge.getAttribute('title'), 'Plafond de travail atteint : ce projet est ralenti');
  await shot('antigel-processus', card);

  // 2) Détail du projet (ouvert par son libellé, jamais par un bouton) : « Budget mémoire… » → 6 Go → config.antigel.budgets
  await card.locator('.card-title .label').click();
  const budgetBtn = win.locator('[data-testid="antigel-budget-button"]');
  await budgetBtn.waitFor();
  assert.match(await budgetBtn.innerText(), /Budget mémoire…/);
  assert.match(await win.locator('h2 [data-testid="antigel-badge"]').innerText(), /ralenti/);
  await budgetBtn.click();
  // ce que fait le budget, en une ligne : d'abord le budget par défaut (champ vide), puis le budget saisi
  const effect = win.locator('[data-testid="antigel-budget-dialog"] [data-testid="antigel-budget-effect"]');
  assert.equal(await effect.innerText(), 'Sans budget propre, budget par défaut (5 Go) : freine à 5 Go · swap 1,25 Go max · au-delà de 6,25 Go, un processus du projet est arrêté.');
  await win.locator('[data-testid="antigel-budget-input"]').fill('6');
  await waitFor(async () => (await effect.innerText()) === 'Freine à 6 Go · swap 1,5 Go max · au-delà de 7,5 Go, un processus du projet est arrêté.', 'effet du budget saisi');
  await shot('antigel-budget-dialogue', win.locator('[data-testid="antigel-budget-dialog"]'));
  await win.locator('[data-testid="antigel-budget-save"]').click();
  await waitFor(() => config().antigel?.budgets?.[proj] === 6144, 'budget 6144 Mo dans config.json');
  await win.locator('[data-testid="antigel-budget-dialog"]').waitFor({ state: 'detached' });
  await waitFor(async () => /Budget : 6 Go/.test(await budgetBtn.innerText()), 'bouton « Budget : 6 Go »');
  await shot('antigel-budget');

  // 2b) Frigo (lot 3) : « Mettre au frigo… » → dialogue → demande déposée par le main (le service est simulé : jamais lancé) ;
  // puis état « au frigo » simulé : badge, ligne du détail, « Réveiller » → demande de réveil
  const requests = () => {
    try {
      return JSON.parse(readFileSync(join(dataApp, 'antigel-fridge-request.json'), 'utf8')).requests;
    } catch {
      return [];
    }
  };
  const fridgeBtn = win.locator('[data-testid="antigel-fridge-button"]');
  await fridgeBtn.waitFor();
  await fridgeBtn.click();
  const fridgeDialog = win.locator('[data-testid="antigel-fridge-dialog"]');
  await fridgeDialog.waitFor();
  assert.match(await fridgeDialog.innerText(), /Mettre « projets \/ alpha » au frigo/);
  await shot('antigel-frigo-dialogue', fridgeDialog);
  await win.locator('[data-testid="antigel-fridge-confirm"]').click();
  await waitFor(() => requests().some((r) => r.root === proj && r.action === 'freeze'), 'demande « frigo » déposée');
  over = {
    fridge: [{ unit, root: proj, since: Date.now(), phase: 'frozen', reclaimedKB: 1.5 * G }],
    fridgeNotice: { root: proj, text: '« alpha » au frigo : ≈ 1,5 Go sortis de la RAM', ok: true, at: Date.now() },
  };
  writeState();
  await waitFor(async () => /au frigo/.test(await win.locator('h2 [data-testid="antigel-badge"]').innerText()), 'badge « au frigo » du détail', 10000);
  assert.match(await win.locator('[data-testid="antigel-fridge-line"]').innerText(), /^Au frigo depuis \d\d:\d\d · ≈ 1,5 Go sortis de la RAM\./);
  const thawBtn = win.locator('[data-testid="antigel-fridge-thaw"]');
  await thawBtn.waitFor();
  await shot('antigel-frigo');
  await thawBtn.click();
  await waitFor(() => requests().some((r) => r.root === proj && r.action === 'thaw'), 'demande « réveiller » déposée');

  // 3) Métriques : carte Plafond de travail (ce qui freine, travail et marge, état récent, arrêts par le noyau) ; le projet
  // a maintenant son budget de 6 Go, avec un plafond dur encore provisoire (convergence après un déploiement)
  over = { ...over, projects: [{ unit, root: proj, procs: 1, currentKB: 2 * G, budgetMB: 6144, throttled: true, maxKB: 9.5 * G }] };
  writeState();
  await win.locator('[data-testid="tab-metrics"]').click();
  const agCard = win.locator('[data-testid="antigel-card"]');
  await agCard.waitFor();
  const agText = await agCard.innerText();
  assert.match(agText, /Le travail est freiné : la RAM est presque pleine/);
  assert.match(agText, /1 projet plafonné/);
  assert.match(agText, /Travail freiné en ce moment \(42 % de la dernière minute\)/);
  assert.match(agText, /1 arrêt par le noyau sous le plafond/);
  assert.doesNotMatch(agText, /ralentissements/);
  assert.match(agText, /1 projet au frigo · ≈ 1,5 Go sortis de la RAM/);
  assert.match(await win.locator('[data-testid="antigel-mem"]').innerText(), /^Travail : 9,0 Go · marge avant ralentissement : aucune$/);
  assert.match(agText, /Bureau prioritaire : processeur : bureau 4× et applications 3× prioritaires sur le travail · protection mémoire sans effet ici/);
  await waitFor(async () => (await win.locator('[data-testid="antigel-budget-effect"]').count()) === 1, 'ligne de l’effet du budget sur la carte', 10000);
  assert.equal(await win.locator('[data-testid="antigel-budget-effect"]').innerText(), 'Budget de 6 Go : freine à 6 Go · swap 1,5 Go max · au-delà de 7,5 Go, un processus du projet est arrêté');
  assert.match(await agCard.innerText(), /projets \/ alpha : 2,0 \/ 6 Go — ok · plafond dur provisoire : 9,5 Go/);
  await shot('antigel-metriques');

  // 4) Réglages → Plafond de travail : état, budget listé puis retiré ; interrupteur éteint
  await win.locator('button[aria-label="Réglages"]').click();
  await win.locator('#settings-tab-antigel').click();
  assert.match(await win.locator('#settings-tab-antigel').innerText(), /Plafond de travail/);
  const status = win.locator('[data-testid="antigel-settings-status"]');
  await waitFor(async () => /^Actif : 1 projet plafonné/.test(await status.innerText()), 'ligne d’état « Actif »');
  const row = win.locator(`[data-testid="antigel-budget-row"][data-root="${proj}"]`);
  await row.waitFor();
  assert.match(await row.innerText(), /6 Go/);
  await row.locator('button', { hasText: 'Retirer' }).click();
  await waitFor(() => Object.keys(config().antigel?.budgets ?? { x: 1 }).length === 0, 'budget retiré de config.json');
  // budget par défaut (5 Go) : le projet en cours reste listé, « par défaut » ; « Sans budget » puis retour au défaut
  await waitFor(async () => (await row.getAttribute('data-source')) === 'default', 'ligne « par défaut » après le retrait');
  assert.match(await row.innerText(), /5 Go \(par défaut\)/);
  await row.locator('button', { hasText: 'Sans budget' }).click();
  await waitFor(() => config().antigel?.noBudget?.includes(proj) === true, 'projet sans budget dans config.json');
  await waitFor(async () => (await row.getAttribute('data-source')) === 'none', 'ligne « sans budget »');
  await row.locator('button', { hasText: 'Budget par défaut' }).click();
  await waitFor(() => config().antigel?.noBudget === undefined, 'projet rendu au budget par défaut');
  // interrupteur du budget par défaut : éteint (null) puis rallumé (5 Go)
  const defSw = win.locator('#settings-panel-antigel button[role="switch"][aria-label="Budget par défaut de chaque projet"]');
  assert.equal(await defSw.getAttribute('aria-checked'), 'true', 'budget par défaut allumé par défaut');
  await defSw.click();
  await waitFor(() => config().antigel?.defaultBudgetMB === null, 'defaultBudgetMB: null dans config.json');
  await defSw.click();
  await waitFor(() => config().antigel?.defaultBudgetMB === 5120, 'defaultBudgetMB: 5120 dans config.json');
  // ce que fait le budget par défaut, en une ligne (absente quand il est éteint)
  const defEffect = win.locator('[data-testid="antigel-default-effect"]');
  await waitFor(async () => (await defEffect.count()) === 1, 'ligne de l’effet du budget par défaut');
  assert.equal(await defEffect.innerText(), 'Budget par défaut (5 Go) : freine à 5 Go · swap 1,25 Go max · au-delà de 6,25 Go, un processus du projet est arrêté');
  // bureau prioritaire : ligne d'état, interrupteur allumé par défaut, éteint puis rallumé (config.antigel.desk)
  assert.match(await win.locator('[data-testid="antigel-desk-status"]').innerText(), /^Bureau prioritaire : processeur/);
  const deskSw = win.locator('#settings-panel-antigel button[role="switch"][aria-label="Bureau prioritaire"]');
  assert.equal(await deskSw.getAttribute('aria-checked'), 'true', 'bureau prioritaire allumé par défaut');
  await deskSw.click();
  await waitFor(() => config().antigel?.desk === false, 'desk: false dans config.json');
  await waitFor(async () => (await deskSw.getAttribute('aria-checked')) === 'false', 'interrupteur du bureau éteint');
  await deskSw.click();
  await waitFor(() => config().antigel?.desk === true, 'desk: true dans config.json');
  const sw = win.locator('#settings-panel-antigel button[role="switch"][aria-label="Plafond de travail"]');
  assert.equal(await sw.count(), 1);
  assert.equal(await sw.getAttribute('aria-checked'), 'true', 'allumé par défaut');
  await sw.click();
  await waitFor(() => config().antigel?.enabled === false, 'enabled: false dans config.json');
  await waitFor(async () => /plafonds levés/.test(await status.innerText()), 'ligne d’état « Éteint »');
  assert.equal(await deskSw.isDisabled(), true, 'bureau prioritaire grisé quand le plafond est éteint');
  assert.equal(await win.locator('[data-testid="antigel-desk-status"]').count(), 0);
  await shot('antigel-reglages');

  // 5) Rallumé, projet dans la slice sans ralentissement : badge « plafonné », carte « actif » (l'état simulé reste
  // « active » : le service n'est pas lancé, c'est lui qui suivrait la config)
  await sw.click();
  await waitFor(() => config().antigel?.enabled === true, 'enabled: true dans config.json');
  // plafond global qui ne freine plus non plus (sinon la carte titre « la RAM est presque pleine »)
  over = {
    projects: [{ unit, root: proj, procs: 1, currentKB: 2 * G, budgetMB: null, throttled: false }],
    slice: { currentKB: 2 * G, highKB: 9 * G, maxKB: 29 * G, swapMaxKB: 10 * G, throttles: 3, oomKills: 1, throttled: false },
  };
  writeState();
  await win.locator('[data-testid="tab-main"]').click();
  await waitFor(async () => (await badge.count()) === 1 && /plafonné/.test(await badge.innerText()), 'badge « plafonné »');
  await win.locator('[data-testid="tab-metrics"]').click();
  await waitFor(async () => /Plafond de travail actif/.test(await agCard.innerText()), 'carte « Plafond de travail actif »');

  // 6) Indisponible : la carte donne la raison, plus aucun badge
  over = { status: 'unavailable', reason: 'contrôleur mémoire non délégué à la session (memory absent de cgroup.subtree_control)', slice: null, projects: [], slices: {}, reserveKB: null };
  writeState();
  await waitFor(async () => /Plafond de travail indisponible : contrôleur mémoire non délégué/.test(await agCard.innerText()), 'carte « indisponible »');
  assert.equal(await win.locator('[data-testid="antigel-mem"]').count(), 0);
  await shot('antigel-indisponible');
  await win.locator('[data-testid="tab-main"]').click();
  await card.waitFor();
  await waitFor(async () => (await win.locator('[data-testid="antigel-badge"]').count()) === 0, 'plus aucun badge', 10000);

  // le node du faux projet s'arrête seul en voyant `.stop`
  writeFileSync(join(proj, '.stop'), '');
  await waitFor(() => !idleAlive(), 'arrêt du node inactif', 10000);

  console.log('ANTIGEL UI E2E OK');
} finally {
  await app?.close().catch(() => {});
  cleanup();
}
