// Page /tmp de bout en bout : onglet, « Voir /tmp » (panneau Alertes, pop-up, notification du bureau), lien de l'explorateur
// du swap, tuiles et tri. Usage : npm run build && node scripts/tmp-page-e2e.mjs
//
// Rien de réel n'est touché : config et données temporaires sous ~/.cache (XDG_CONFIG_HOME, XDG_DATA_HOME : jamais la vraie
// metrics.db), service systemd laissé tranquille (PROC_WATCH_NO_RECORDER_SYNC), racine /tmp factice sous ~/.cache/pw-…
// (PROC_WATCH_TMP_ROOT, avec son fichier témoin), earlyoom simulé (PROC_WATCH_EARLYOOM_FAKE : aucun pop-up selon la machine).
// Aucune suppression n'est demandée : aucun bouton « Supprimer » ni
// « Vider la quarantaine » n'est cliqué ; seuls de faux caches connus de la racine factice sont vidés (« Vider »). L'alerte tmpfs est simulée en remplaçant, dans le main, les gestionnaires IPC
// de lecture des alertes. Captures seulement si TMP_PAGE_SHOTS désigne un dossier (hors du dépôt).
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
// faux caches connus : Jest (101 Mo : bouton du pop-up à partir de 100 Mo ; dossiers gardés au vidage), Node.js, et un
// « cache » v8-compile-cache qui n'est qu'un lien vers un dossier précieux (jamais suivi, jamais vidé)
const uid = process.getuid();
const jestCache = join(root, `jest_${uid.toString(36)}`);
mkdirSync(join(jestCache, 'jest-transform-cache-x', '0f'), { recursive: true });
fill(join(jestCache, 'jest-transform-cache-x', '0f', 'mod_0f'), 101 * 1024);
fill(join(jestCache, 'haste-map-x'), 64);
const ncc = join(root, 'node-compile-cache');
mkdirSync(join(ncc, 'v24-x64-abc'), { recursive: true });
fill(join(ncc, 'v24-x64-abc', '0026279'), 1024);
const precious = join(base, 'precieux');
mkdirSync(precious);
writeFileSync(join(precious, 'garder.txt'), 'garder');
symlinkSync(precious, join(root, `v8-compile-cache-${uid}`));
const CACHE_NAMES = [`jest_${uid.toString(36)}`, 'node-compile-cache', `v8-compile-cache-${uid}`];
const filesUnder = (d) => readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => !e.isDirectory()).map((e) => e.name);

const shots = process.env.TMP_PAGE_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
// page /tmp : fenêtre entière (seulement la racine factice) ; ailleurs, l'élément seul (jamais les groupes ni les projets)
const shot = async (win, name) => shots && win.screenshot({ path: join(shots, `${name}.png`) });
const shotOf = async (locator, name) => shots && locator.screenshot({ path: join(shots, `${name}.png`) });

// earlyoom simulé (dossier vide : vu installé et actif, rien à proposer) : aucun pop-up earlyoom selon l'état réel de la machine
const eoFake = join(base, 'earlyoom');
mkdirSync(eoFake);
const env = { ...process.env, XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: data, PROC_WATCH_NO_RECORDER_SYNC: '1', PROC_WATCH_NO_ANTIGEL: '1', PROC_WATCH_TMP_ROOT: root, PROC_WATCH_EARLYOOM_FAKE: eoFake };
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
  const names = async () => (await win.locator('[data-testid="tmp-clean-row"] label').allInnerTexts()).filter((n) => !n.startsWith('.') && !CACHE_NAMES.includes(n));
  assert.deepEqual(await names(), ['acme-build', 'Beta-logs', 'feature-x', 'zeta-notes.txt'], 'tri par taille décroissante par défaut');
  await shot(win, 'tmp-page-taille');
  // 1 ter) caches connus : Jest et Node.js vidables, le lien refusé ; « Tout vider » ; conseil cacheDirectory
  const caches = win.locator('[data-testid="tmp-caches"]');
  await caches.locator('[data-testid="tmp-cache-row"]').first().waitFor();
  assert.equal(await caches.locator('[data-testid="tmp-cache-row"]').count(), 3);
  const cachesText = await caches.innerText();
  assert.match(cachesText, new RegExp(`Cache de transformation de Jest\\s*jest_${uid.toString(36)}\\s*101 Mo`));
  assert.match(cachesText, /Cache de compilation de Node\.js\s*node-compile-cache\s*1 Mo/);
  assert.match(cachesText, /v8-compile-cache-\d+\s*lien symbolique \(jamais suivi\)/);
  assert.match(cachesText, /cacheDirectory/);
  assert.match(await win.locator('[data-testid="tmp-caches-empty-all"]').innerText(), /Tout vider \(102 Mo\)/);
  assert.equal(await win.locator('[data-testid="tmp-cache-empty-v8-compile-cache"]').count(), 0);
  await shotOf(caches, 'tmp-page-caches');
  // « Vider » Node.js (un clic, sans confirmation) : fichiers supprimés, dossiers gardés, rien d'autre touché
  await win.locator('[data-testid="tmp-cache-empty-node-compile-cache"]').click();
  await win.locator('.toast', { hasText: 'Cache Node.js vidé : 1 Mo libérés' }).waitFor();
  await win.locator('[data-testid="tmp-cache-empty-node-compile-cache"]').waitFor({ state: 'detached' });
  assert.deepEqual(filesUnder(ncc), [], 'fichiers du cache Node.js supprimés');
  assert.ok(existsSync(join(ncc, 'v24-x64-abc')), 'dossiers du cache gardés');
  assert.equal(filesUnder(jestCache).length, 2, 'cache Jest pas encore touché');
  assert.equal(readFileSync(join(precious, 'garder.txt'), 'utf8'), 'garder', 'lien jamais suivi');
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
  await win.locator('[data-testid="tmp-clean-row"]', { hasText: 'acme-build' }).locator('input[type="checkbox"]').check();
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

  // 7) pop-up d'alerte → « Vider … » (Jest : au moins 100 Mo), puis page /tmp
  await backToMain();
  const popupGo = win.locator('[data-testid="alert-popup"] .alert-popup-go', { hasText: 'Voir /tmp' });
  await popupGo.waitFor({ timeout: 20000 });
  assert.equal(await popupGo.getAttribute('aria-expanded'), null);
  const popupEmpty = win.locator('[data-testid="alert-popup-empty-caches"]');
  await popupEmpty.waitFor();
  // mesuré à l'apparition du pop-up : avant ou après le vidage de Node.js ci-dessus
  assert.match(await popupEmpty.innerText(), /Vider (le cache Jest|les caches) \(10[12] Mo\)/);
  await shotOf(win.locator('[data-testid="alert-popup"]').first(), 'popup');
  await popupEmpty.click();
  await win.locator('.toast', { hasText: /(Cache Jest vidé|2 caches vidés) : 101 Mo libérés/ }).waitFor();
  await popupEmpty.waitFor({ state: 'detached' });
  assert.deepEqual(filesUnder(jestCache), [], 'fichiers du cache Jest supprimés');
  assert.ok(existsSync(join(jestCache, 'jest-transform-cache-x', '0f')), 'dossiers du cache Jest gardés');
  assert.equal(readFileSync(join(precious, 'garder.txt'), 'utf8'), 'garder', 'lien jamais suivi');
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
