// « Redémarrer le service » d'enregistrement, fenêtre de bout en bout. Usage : npm run test:service-restart
//
// Rien de réel n'est touché : HOME et XDG temporaires sous ~/.cache/pw-service-restart-e2e-* (jamais la vraie config ni la
// vraie metrics.db), PROC_WATCH_NO_RECORDER_SYNC=1 (le main refuse alors de relancer quoi que ce soit : aucun systemctl, le vrai
// service n'est jamais redémarré), PROC_WATCH_NO_KILL=1, PROC_WATCH_NO_ANTIGEL=1, earlyoom simulé. Le statut du service est
// SIMULÉ (recorder-status.json écrit par ce script) avec le PID du main de l'app de test : sa carte et sa ligne portent le
// bouton. Aucun bouton Tuer n'est cliqué (la carte est ouverte par son libellé). Captures seulement si SERVICE_RESTART_SHOTS
// désigne un dossier (hors du dépôt).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

mkdirSync(join(homedir(), '.cache'), { recursive: true });
const base = realpathSync(mkdtempSync(join(homedir(), '.cache', 'pw-service-restart-e2e-')));
let app = null;
let timer = null;
const cleanup = () => {
  clearInterval(timer);
  rmSync(base, { recursive: true, force: true });
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, async () => {
    await Promise.race([app?.close().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
    cleanup();
    process.exit(130);
  });
}
const waitFor = async (fn, what, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`délai dépassé : ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};
/** Clic DOM : la fenêtre peut être cachée (Chromium suspend alors requestAnimationFrame). */
const press = async (loc) => {
  await loc.waitFor({ timeout: 10000 });
  await loc.evaluate((el) => el.click());
};

try {
  const home = join(base, 'home');
  const cfg = join(base, 'cfg');
  const data = join(base, 'data');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(cfg, 'computer-watcher'), { recursive: true });
  writeFileSync(join(cfg, 'computer-watcher', 'onboarding.json'), '{"version":1,"done":true}\n');
  const dataApp = join(data, 'computer-watcher');
  mkdirSync(dataApp, { recursive: true });

  const env = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: data, XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(base, 'state'),
    PROC_WATCH_NO_RECORDER_SYNC: '1', PROC_WATCH_NO_KILL: '1', PROC_WATCH_NO_ANTIGEL: '1', PROC_WATCH_EARLYOOM_FAKE: join(base, 'earlyoom'),
  };
  mkdirSync(env.PROC_WATCH_EARLYOOM_FAKE);
  app = await electron.launch({ args: ['.'], env });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1280, height: 900 }).catch(() => {});
  await win.waitForSelector('[data-testid="snapshot-ready"]', { timeout: 20000 });
  await win.locator('[data-testid="earlyoom-popup-later"]').click({ timeout: 3000 }).catch(() => {});
  const shots = process.env.SERVICE_RESTART_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  const shot = async (name, el) => { if (shots) await el.screenshot({ path: join(shots, `${name}.png`) }); };

  // statut simulé du service : le main de l'app de test, mesure fraîche toutes les secondes
  const pid = await app.evaluate(() => process.pid);
  const startedAt = Date.now();
  const writeStatus = (lastSampleAt) => {
    const p = join(dataApp, 'recorder-status.json');
    writeFileSync(`${p}.tmp`, JSON.stringify({ pid, startedAt, lastSampleAt, lastError: null, earlyoomSource: 'ok', dbSizeBytes: 0 }));
    renameSync(`${p}.tmp`, p);
  };
  writeStatus(Date.now());
  timer = setInterval(() => writeStatus(Date.now()), 1000);

  const restartBtn = win.locator('[data-testid="service-restart"]');
  const toast = (re) => waitFor(async () => (await win.locator('.toast').allInnerTexts()).some((t) => re.test(t)), `toast ${re}`);
  const NO_SYNC = /Service géré hors de l’app \(PROC_WATCH_NO_RECORDER_SYNC\) : rien n’est relancé\./;

  // 1) Processus, cartes : une seule carte porte le bouton, juste avant son kill
  await waitFor(async () => (await restartBtn.count()) === 1, 'bouton « Redémarrer le service » sur une carte');
  const card = win.locator('[data-testid="group-card"]', { has: restartBtn });
  assert.equal(await card.count(), 1);
  assert.equal(await restartBtn.getAttribute('aria-label'), 'Redémarrer le service');
  assert.equal(await restartBtn.evaluate((b) => b.nextElementSibling?.getAttribute('aria-label')), 'Tuer', 'à côté du bouton Tuer');
  await shot('card', card);
  await press(restartBtn);
  await toast(NO_SYNC);

  // 2) Vue liste : même bouton sur la ligne
  await press(win.locator('[data-testid="view-list"]'));
  await waitFor(async () => (await win.locator('[data-testid="group-row"]', { has: restartBtn }).count()) === 1, 'bouton sur la ligne de la liste');
  assert.equal(await restartBtn.count(), 1);
  await shot('list-row', win.locator('[data-testid="group-row"]', { has: restartBtn }));
  await press(win.locator('[data-testid="view-cards"]'));

  // 3) Détail de la carte (ouverte par son libellé) : bouton sur la ligne du processus du service, et seulement là
  await waitFor(async () => (await card.count()) === 1, 'carte du service revenue');
  await press(card.locator('.card-titles .label'));
  const row = win.locator('table.tree tbody tr', { has: win.locator('td.pid', { hasText: new RegExp(`^\\s*${pid}\\s*$`) }) });
  await waitFor(async () => (await row.count()) === 1, `ligne du processus ${pid}`, 20000);
  await waitFor(async () => (await row.locator('[data-testid="service-restart"]').count()) === 1, 'bouton sur la ligne du processus');
  assert.equal(await win.locator('table.tree [data-testid="service-restart"]').count(), 1, 'une seule ligne');
  await shot('process-row', row);
  await press(row.locator('[data-testid="service-restart"]'));
  await waitFor(async () => (await win.locator('.toast').allInnerTexts()).filter((t) => NO_SYNC.test(t)).length >= 1, 'toast du détail');

  // 4) statut périmé (service arrêté) : plus aucun bouton
  clearInterval(timer);
  writeStatus(Date.now() - 60_000);
  await waitFor(async () => (await restartBtn.count()) === 0, 'bouton retiré quand le service ne mesure plus');

  console.log('SERVICE RESTART E2E OK');
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    await app.close().catch(() => {});
  }
  cleanup();
}
