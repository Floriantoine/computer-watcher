// Page /tmp de bout en bout : onglet, « Voir /tmp » (panneau Alertes, pop-up, notification du bureau), lien de l'explorateur
// du swap, tuiles et tri. Usage : npm run build && node scripts/tmp-page-e2e.mjs
//
// Rien de réel n'est touché : config et données temporaires sous ~/.cache (XDG_CONFIG_HOME, XDG_DATA_HOME : jamais la vraie
// metrics.db), service systemd laissé tranquille (PROC_WATCH_NO_RECORDER_SYNC), racine /tmp factice sous ~/.cache/pw-…
// (PROC_WATCH_TMP_ROOT, avec son fichier témoin). Aucune suppression n'est demandée : aucun bouton « Supprimer » ni
// « Vider la quarantaine » n'est cliqué. L'alerte tmpfs est simulée en remplaçant, dans le main, les gestionnaires IPC
// de lecture des alertes. Captures seulement si TMP_PAGE_SHOTS désigne un dossier (hors du dépôt).
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

mkdirSync(join(homedir(), '.cache'), { recursive: true });
const base = mkdtempSync(join(homedir(), '.cache', 'pw-tmp-page-'));
const cfg = join(base, 'cfg');
const data = join(base, 'data');
const root = join(base, 'root');
mkdirSync(join(cfg, 'computer-watcher'), { recursive: true });
writeFileSync(join(cfg, 'computer-watcher', 'onboarding.json'), '{"version":1,"done":true}\n');
mkdirSync(data, { recursive: true });

// racine factice : noms neutres, tailles distinctes (tri), une quarantaine restée
mkdirSync(root);
writeFileSync(join(root, '.computer-watcher-test-root'), '');
const fill = (path, kb) => writeFileSync(path, Buffer.alloc(kb * 1024, 1));
mkdirSync(join(root, 'acme-build'));
fill(join(root, 'acme-build', 'bundle.js'), 3072);
mkdirSync(join(root, 'feature-x'));
fill(join(root, 'feature-x', 'cache.bin'), 512);
fill(join(root, 'zeta-notes.txt'), 64);
mkdirSync(join(root, 'Beta-logs'));
fill(join(root, 'Beta-logs', 'app.log'), 1024);
mkdirSync(join(root, '.proc-watch-trash-1'));
fill(join(root, '.proc-watch-trash-1', 'reste.bin'), 128);
chmodSync(join(root, '.proc-watch-trash-1'), 0o700);

const shots = process.env.TMP_PAGE_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
// page /tmp : fenêtre entière (seulement la racine factice) ; ailleurs, l'élément seul (jamais les groupes ni les projets)
const shot = async (win, name) => shots && win.screenshot({ path: join(shots, `${name}.png`) });
const shotOf = async (locator, name) => shots && locator.screenshot({ path: join(shots, `${name}.png`) });

const env = { ...process.env, XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: data, PROC_WATCH_NO_RECORDER_SYNC: '1', PROC_WATCH_TMP_ROOT: root };
const app = await electron.launch({ args: ['.'], env });
try {
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1280, height: 860 }).catch(() => {});
  await win.waitForSelector('[data-testid="snapshot-ready"]', { timeout: 20000 });

  // alerte tmpfs simulée : lue par le panneau Alertes, les pop-ups et la notification « Ouvrir »
  await app.evaluate(({ ipcMain }) => {
    const ev = { id: 900001, ts: Date.now(), type: 'tmpfs', groupKey: null, groupLabel: null, detail: { shmemKB: 6 * 1024 * 1024, thresholdKB: 4 * 1024 * 1024 } };
    for (const ch of ['history:events', 'alerts:unseen', 'alerts:get']) ipcMain.removeHandler(ch);
    ipcMain.handle('history:events', () => [{ ts: ev.ts, type: ev.type, groupKey: null, groupLabel: null, detail: ev.detail }]);
    ipcMain.handle('alerts:unseen', () => ({ total: 1, alerts: [ev] }));
    ipcMain.handle('alerts:get', () => ev);
  });

  const page = win.locator('[data-testid="tmp-page"]');
  const backToMain = async () => {
    await win.locator('[data-testid="tab-main"]').click();
    await page.waitFor({ state: 'detached' });
  };

  // 1) onglet
  await win.locator('[data-testid="tab-tmp"]').click();
  await page.waitFor();
  await win.locator('[data-testid="tmp-clean-row"]').first().waitFor();
  assert.equal(await win.locator('[data-testid="tab-tmp"]').getAttribute('aria-selected'), 'true');
  assert.match(await win.locator('[data-testid="tmp-clean-root"]').innerText(), /pw-tmp-page-/);
  assert.equal(await win.locator('[data-testid="tmp-tile"]').count(), 3);
  await win.waitForFunction(() => !document.querySelector('[data-testid="tmp-tiles"]')?.textContent?.includes('…'));
  const tiles = await win.locator('[data-testid="tmp-tiles"]').innerText();
  // la racine de test est sous ~/.cache, sur disque : pas de part de la RAM (vrai statfs)
  assert.match(tiles, /Occupé\s*[\d,]+ [KMG]o \/ [\d,]+ [KMG]o[\s\S]*Part de la RAM\s*—\s*pas en RAM[\s\S]*Quarantaine\s*1/);
  assert.equal(await win.locator('[data-testid="tmp-clean-empty-quarantine"]').count(), 1);
  // entrées système de la racine (fichier témoin, quarantaine) : listées, refusées ; hors du contrôle d'ordre
  const names = async () => (await win.locator('[data-testid="tmp-clean-row"] label').allInnerTexts()).filter((n) => !n.startsWith('.'));
  assert.deepEqual(await names(), ['acme-build', 'Beta-logs', 'feature-x', 'zeta-notes.txt'], 'tri par taille décroissante par défaut');
  await shot(win, 'tmp-page-taille');
  // 1 bis) même page sur un tmpfs (statfs simulé : 2,5 Go occupés sur 16 Go, 32 Go de RAM)
  await app.evaluate(({ ipcMain }, r) => {
    ipcMain.removeHandler('tmp:stats');
    ipcMain.handle('tmp:stats', () => ({ root: r, sizeKB: 16 * 1024 * 1024, usedKB: 2.5 * 1024 * 1024, memTotalKB: 32 * 1024 * 1024, inRam: true }));
  }, root);
  await win.locator('[data-testid="tmp-refresh"]').click();
  await win.locator('[data-testid="tmp-tiles"]', { hasText: '7,8 %' }).waitFor();
  assert.match(await win.locator('[data-testid="tmp-tiles"]').innerText(), /2,5 Go \/ 16,0 Go\s*16 % occupé\s*Part de la RAM\s*7,8 %\s*de 32,0 Go de RAM/);
  await shot(win, 'tmp-page-tmpfs');
  // 2) tri par nom, puis retour à la taille
  await win.locator('[data-testid="tmp-sort-name"]').click();
  assert.deepEqual(await names(), ['acme-build', 'Beta-logs', 'feature-x', 'zeta-notes.txt'].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' })));
  assert.equal(await win.locator('[data-testid="tmp-sort-name"]').getAttribute('aria-pressed'), 'true');
  await shot(win, 'tmp-page-nom');
  await win.locator('[data-testid="tmp-sort-size"]').click();
  // 3) sélection : résumé et libellé du bouton (sans jamais cliquer « Supprimer »)
  await win.locator('[data-testid="tmp-clean-row"] input[type="checkbox"]').first().check();
  await win.locator('[data-testid="tmp-clean-summary"]').waitFor();
  assert.match(await win.locator('[data-testid="tmp-clean-delete"]').innerText(), /Supprimer la sélection \(1 · 3 Mo\)/);
  await shot(win, 'tmp-page-selection');
  // 4) « Actualiser » : la liste est relue (nouvel élément visible)
  fill(join(root, 'nouveau.dat'), 16);
  await win.locator('[data-testid="tmp-refresh"]').click();
  await win.locator('[data-testid="tmp-clean-row"] label', { hasText: 'nouveau.dat' }).waitFor();

  // 5) panneau Alertes (Métriques) → page /tmp
  await backToMain();
  await win.locator('[data-testid="tab-metrics"]').click();
  const toggle = win.locator('[data-testid="tmpfs-toggle"]');
  await toggle.waitFor({ timeout: 15000 });
  assert.equal(await toggle.getAttribute('aria-expanded'), null);
  await shotOf(win.locator('[data-testid="alerts"]'), 'metriques-alertes');
  await toggle.click();
  await page.waitFor();

  // 6) explorateur du swap → page /tmp
  await win.locator('[data-testid="tab-metrics"]').click();
  await win.locator('[data-testid="swap-shmem"] button').click();
  const open = win.locator('[data-testid="tmp-dirs-open-page"]');
  await open.waitFor();
  await shotOf(win.locator('.swap-tmp'), 'swap-explorateur');
  await open.click();
  await page.waitFor();

  // 7) pop-up d'alerte → page /tmp
  await backToMain();
  const popupGo = win.locator('[data-testid="alert-popup"] .alert-popup-go', { hasText: 'Voir /tmp' });
  await popupGo.waitFor({ timeout: 20000 });
  assert.equal(await popupGo.getAttribute('aria-expanded'), null);
  await shotOf(win.locator('[data-testid="alert-popup"]').first(), 'popup');
  await popupGo.click();
  await page.waitFor();

  // 8) notification du bureau « Ouvrir » → page /tmp
  await backToMain();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('alert:open', 900001));
  await page.waitFor();
  await shot(win, 'tmp-page-notification');

  // 9) /tmp illisible : les tuiles affichent l'erreur (après une première lecture réussie)
  await win.locator('[data-testid="tmp-clean-delete"]').waitFor();
  await app.evaluate(({ ipcMain }) => {
    for (const ch of ['tmp:stats', 'tmp:entries']) ipcMain.removeHandler(ch);
    const fail = () => {
      throw new Error('accès refusé (EACCES)');
    };
    ipcMain.handle('tmp:stats', fail);
    ipcMain.handle('tmp:entries', fail);
  });
  await win.locator('[data-testid="tmp-refresh"]').click();
  await win.waitForFunction(() => document.querySelectorAll('[data-testid="tmp-tile-error"]').length === 3);
  assert.match(await win.locator('[data-testid="tmp-tiles"]').innerText(), /Lecture impossible : .*accès refusé \(EACCES\)/);
  assert.doesNotMatch(await win.locator('[data-testid="tmp-tiles"]').innerText(), /NaN/);
  // liste illisible : plus aucune ligne ni bouton « Supprimer » d'une lecture précédente
  assert.equal(await win.locator('[data-testid="tmp-clean-row"]').count(), 0);
  assert.equal(await win.locator('[data-testid="tmp-clean-delete"]').count(), 0);
  await shot(win, 'tmp-page-erreur');

  console.log('TMP PAGE E2E OK');
} finally {
  await app.evaluate(({ app }) => app.quit()).catch(() => {});
  await app.close().catch(() => {});
  rmSync(base, { recursive: true, force: true });
}
