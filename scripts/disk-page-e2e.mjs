// Page Disque de bout en bout : onglet, bandes, soleil, familles, « Libérer… » sur des caches factices.
// Usage : npm run build && node scripts/disk-page-e2e.mjs
//
// Rien de réel n'est touché : HOME et XDG_* temporaires sous ~/.cache/pw-disk-page-* (faux caches npm, uv, Playwright,
// un dossier « précieux » et ~/.cache/pip qui pointe dessus), config et données temporaires (jamais la vraie metrics.db),
// service systemd laissé tranquille (PROC_WATCH_NO_RECORDER_SYNC), pkexec simulé (PROC_WATCH_DISK_ROOT_FAKE, hors paquet
// seulement : aucune famille root n'est d'ailleurs cochée). La boîte de confirmation native est remplacée, dans le main,
// par une réponse « Supprimer définitivement » enregistrée. Captures seulement si DISK_PAGE_SHOTS désigne un dossier
// (hors du dépôt).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

mkdirSync(join(homedir(), '.cache'), { recursive: true });
const base = realpathSync(mkdtempSync(join(homedir(), '.cache', 'pw-disk-page-')));
const home = join(base, 'home');
const cfg = join(base, 'cfg');
const data = join(base, 'data');
const cache = join(home, '.cache');
mkdirSync(join(cfg, 'computer-watcher'), { recursive: true });
writeFileSync(join(cfg, 'computer-watcher', 'onboarding.json'), '{"version":1,"done":true}\n');
mkdirSync(data, { recursive: true });

// dossier personnel factice : noms neutres, tailles distinctes
const fill = (path, kb) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(kb * 1024, 1));
};
fill(join(home, '.npm/_cacache/content-v2/sha512/aa/paquet'), 5 * 1024);
fill(join(home, '.npm/_logs/garde.log'), 16);
fill(join(cache, 'uv/wheels/roue.whl'), 3 * 1024);
fill(join(cache, 'ms-playwright/chromium-1140/chrome'), 2 * 1024);
fill(join(cache, 'ms-playwright/chromium-1155/chrome'), 2 * 1024);
fill(join(cache, 'vignettes/a.png'), 1024);
fill(join(home, 'Documents/rapport.odt'), 6 * 1024);
fill(join(home, 'Documents/précieux/these.odt'), 2 * 1024);
fill(join(home, 'Images/vacances.jpg'), 4 * 1024);
fill(join(home, 'Musique/morceau.flac'), 3 * 1024);
fill(join(home, 'projets/alpha/build.bin'), 2 * 1024);
fill(join(home, 'projets/beta/notes.txt'), 512);
symlinkSync(join(home, 'Documents/précieux'), join(cache, 'pip'));

const shots = process.env.DISK_PAGE_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const shot = async (win, name) => shots && win.screenshot({ path: join(shots, `${name}.png`) });

const env = {
  ...process.env, HOME: home, XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: data, XDG_CACHE_HOME: cache, XDG_STATE_HOME: join(base, 'state'),
  PROC_WATCH_NO_RECORDER_SYNC: '1', PROC_WATCH_DISK_ROOT_FAKE: '1',
};
const app = await electron.launch({ args: ['.'], env });
try {
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1280, height: 900 }).catch(() => {});
  await win.waitForSelector('[data-testid="snapshot-ready"]', { timeout: 20000 });

  // confirmation native remplacée (test seulement) : réponse « Supprimer définitivement », message gardé
  await app.evaluate(({ dialog }) => {
    globalThis.__diskConfirms = [];
    dialog.showMessageBox = async (...a) => {
      const o = a.length > 1 ? a[1] : a[0];
      globalThis.__diskConfirms.push({ message: o.message, detail: o.detail });
      return { response: 1, checkboxChecked: false };
    };
  });

  // 1) onglet, bandes, soleil, familles
  await win.locator('[data-testid="tab-disk"]').click();
  await win.locator('[data-testid="disk-page"]').waitFor();
  assert.equal(await win.locator('[data-testid="tab-disk"]').getAttribute('aria-selected'), 'true');
  await win.locator('[data-testid="disk-band"]').first().waitFor({ timeout: 15000 });
  assert.match(await win.locator('[data-testid="disk-band"]').first().innerText(), /libres sur/);
  await win.locator('[data-testid="disk-sun-arc"]').first().waitFor({ timeout: 30000 });
  assert.match(await win.locator('[data-testid="disk-scan-status"]').innerText(), /Parcouru à/);
  const arcs = await win.locator('[data-testid="disk-sun-arc"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-path')));
  assert.ok(arcs.includes(join(home, 'Documents')), 'Documents dans le soleil');
  assert.ok(!arcs.some((p) => p === join(cache, 'pip')), 'le lien ~/.cache/pip n’est jamais suivi (compté 0)');
  const row = (id) => win.locator(`[data-testid="disk-family-row"][data-id="${id}"]`);
  await row('npm').waitFor({ timeout: 30000 });
  for (const id of ['npm', 'uv', 'test-browsers', 'pip']) assert.equal(await row(id).count(), 1, `famille ${id}`);
  // ~/.cache/pip est un lien : refusé dès la liste, case désactivée
  assert.match(await row('pip').innerText(), /lien symbolique/);
  assert.equal(await row('pip').locator('input').isDisabled(), true);
  await shot(win, 'disque-page');

  // 2) survol d'un segment : nom, chemin, taille, part du parent
  await win.locator(`[data-testid="disk-sun-arc"][data-path="${join(home, 'Documents')}"]`).hover();
  await win.locator('[data-testid="disk-sun-tip"]').waitFor();
  assert.match(await win.locator('[data-testid="disk-sun-tip"]').innerText(), /Documents[\s\S]*~\/Documents[\s\S]*% du parent/);
  await shot(win, 'disque-survol');

  // 3) entrer dans .cache (clic), puis cliquer le segment uv : coche la famille ; remonter par le centre
  await win.locator(`[data-testid="disk-sun-arc"][data-path="${cache}"]`).click();
  await win.locator('.crumb', { hasText: '.cache' }).waitFor();
  await win.locator(`[data-testid="disk-sun-arc"][data-path="${join(cache, 'uv')}"]`).click();
  assert.equal(await row('uv').locator('input').isChecked(), true, 'clic sur le segment uv → famille cochée');
  await win.locator(`[data-testid="disk-sun-arc"][data-path="${join(cache, 'uv')}"].lit`).waitFor();
  await shot(win, 'disque-cache-uv');
  await win.locator('[data-testid="disk-sun-center"]').click();
  await win.locator(`[data-testid="disk-sun-arc"][data-path="${join(home, 'Documents')}"]`).waitFor();

  // 4) cocher npm et les navigateurs de test ; « Libérer… »
  await row('npm').locator('input').check();
  await row('test-browsers').locator('input').check();
  assert.match(await win.locator('[data-testid="disk-free-button"]').innerText(), /Libérer ≈ [\d,]+ Mo…/);
  await shot(win, 'disque-selection');
  await win.locator('[data-testid="disk-free-button"]').click();
  const toast = win.locator('.toast', { hasText: 'libérés' });
  await toast.waitFor({ timeout: 20000 });
  const confirms = await app.evaluate(() => globalThis.__diskConfirms);
  assert.equal(confirms.length, 1, 'une seule confirmation');
  assert.match(confirms[0].detail, /Cache npm[\s\S]*Navigateurs de test[\s\S]*définitif/);
  assert.match(confirms[0].detail, /Cache uv/);
  await shot(win, 'disque-libere');

  // 5) sur le disque. Un outil de la famille qui tourne vraiment sur la machine (ex. un serveur lancé par uvx) fait
  // refuser sa famille : elle doit alors rester intacte, avec le nom et le pid d'un processus vivant.
  const ev0 = readFileSync(join(data, 'computer-watcher', 'app-events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.type === 'disk_clean');
  const refusedNow = new Map(ev0.detail.refused.map((x) => [x.id, x.reason]));
  const expectGone = (id, path) => {
    if (!refusedNow.has(id)) return assert.equal(existsSync(path), false, `${id} supprimé`);
    const m = /^utilisé par .+ \(pid (\d+)\)$/.exec(refusedNow.get(id));
    assert.ok(m, `${id} refusé seulement parce qu’un processus l’utilise : ${refusedNow.get(id)}`);
    assert.ok(existsSync(`/proc/${m[1]}`), `processus ${m[1]} vivant`);
    assert.equal(existsSync(path), true, `${id} refusé : intact`);
    console.log(`note : ${id} refusé (${refusedNow.get(id)}), laissé intact`);
  };
  expectGone('npm', join(home, '.npm/_cacache'));
  assert.equal(existsSync(join(home, '.npm/_logs/garde.log')), true, 'voisin de npm intact');
  expectGone('uv', join(cache, 'uv'));
  assert.ok(!refusedNow.has('test-browsers'), 'navigateurs de test traités');
  assert.deepEqual(readdirSync(join(cache, 'ms-playwright')).sort(), ['chromium-1155']);
  assert.equal(existsSync(join(cache, 'vignettes/a.png')), true);
  assert.deepEqual(readdirSync(join(home, 'Documents/précieux')), ['these.odt']);
  assert.equal(readFileSync(join(home, 'Documents/précieux/these.odt')).length, 2 * 1024 * 1024);

  // 6) pip (lien vers le précieux) demandé directement au main : refusé, rien supprimé
  const r = await win.evaluate(() => window.procWatch.disk.clean(['pip']));
  assert.equal(r.done.length, 0);
  assert.match(r.refused[0]?.reason ?? '', /lien symbolique/);
  assert.equal(existsSync(join(cache, 'pip')), true, 'le lien lui-même reste');
  assert.deepEqual(readdirSync(join(home, 'Documents/précieux')), ['these.odt']);
  // ids inconnus : rejetés avant toute action
  await assert.rejects(win.evaluate(() => window.procWatch.disk.clean(['npm', '../../etc'])));

  // 7) historique : un événement disk_clean pour le ménage
  const events = readFileSync(join(data, 'computer-watcher', 'app-events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ev = events.find((e) => e.type === 'disk_clean' && e.detail.done.includes('npm'));
  assert.ok(ev, 'événement disk_clean');
  assert.deepEqual([...ev.detail.done, ...ev.detail.refused.map((x) => x.id)].sort(), ['npm', 'test-browsers', 'uv']);
  assert.ok(ev.detail.done.includes('test-browsers'));

  console.log('DISK PAGE E2E OK');
} finally {
  await app.evaluate(({ app }) => app.quit()).catch(() => {});
  await app.close().catch(() => {});
  rmSync(base, { recursive: true, force: true });
}
