// Mises à jour de bout en bout contre un flux local (aucun réseau, aucune vraie AppImage, rien n'est installé ni exécuté) :
// petit serveur HTTP sur 127.0.0.1 (latest-linux.yml + faux fichier de 64 Ko, releases.json façon API GitHub), app lancée
// depuis les sources avec PROC_WATCH_UPDATE_FEED. Prérequis : `npm run build`.
//   A. « AppImage » (APPIMAGE factice) : vérification automatique à 30 s → pop-up → « Mettre à jour » → téléchargement,
//      sha512 vérifié → « Redémarrer et installer » affiché (jamais cliqué).
//   B. sha512 faux : « Échec du téléchargement » et « Réessayer ».
//   C. pas une AppImage : notification seulement (« Voir la version », pas de téléchargement).
//   D. sans flux : aucune vérification (Réglages › À propos).
//   E. APPIMAGE/APPDIR hérités d'une autre application : jamais le mode installation (notification seulement).
//   F. copie installée (~/Applications/proc-watch.AppImage) présente, autre AppImage lancée : « lancez proc-watch depuis le menu ».
//   G. variable PROC_WATCH_UPDATE_FEED sans l'option --update-feed-test : ignorée.
// « AppImage » factice : APPDIR = dossier du binaire electron en cours (tenu pour un montage seulement avec
// --update-feed-test, voir testFeedTrust), APPIMAGE = petit fichier ordinaire à en-tête AppImage, hors de APPDIR.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { _electron as electron } from 'playwright';

const payload = randomBytes(64 * 1024);
const sha512 = createHash('sha512').update(payload).digest('base64');
const FILE = 'proc-watch-9.9.9-x86_64.AppImage';
let badSha = false;
const hits = [];
const yml = () =>
  [
    'version: 9.9.9',
    'files:',
    `  - url: ${FILE}`,
    `    sha512: ${badSha ? createHash('sha512').update('autre').digest('base64') : sha512}`,
    `    size: ${payload.length}`,
    `path: ${FILE}`,
    `sha512: ${badSha ? createHash('sha512').update('autre').digest('base64') : sha512}`,
    "releaseDate: '2026-10-09T00:00:00.000Z'",
    "releaseNotes: '<p>Notes de test : plus rapide.</p>'",
    '',
  ].join('\n');
const releases = JSON.stringify([
  { tag_name: 'v9.9.9', html_url: 'https://github.com/Floriantoine/computer-watcher/releases/tag/v9.9.9', body: 'Notes de test (API).', draft: false, prerelease: false },
]);
/** Jeton aléatoire exigé en tête du chemin du flux de test (testFeedFromEnv). */
const TOKEN = randomBytes(24).toString('hex');
const server = createServer((req, res) => {
  const full = new URL(req.url, 'http://x').pathname; // electron-updater ajoute ?noCache=…
  if (!full.startsWith(`/${TOKEN}/`)) return void res.writeHead(404).end();
  const path = full.slice(TOKEN.length + 1);
  hits.push(path);
  if (path === '/latest-linux.yml') res.writeHead(200, { 'content-type': 'text/yaml' }).end(yml());
  else if (path === `/${FILE}`) res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length }).end(payload);
  else if (path === '/releases.json') res.writeHead(200, { 'content-type': 'application/json' }).end(releases);
  else res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const feed = `http://127.0.0.1:${server.address().port}/${TOKEN}/`;

mkdirSync(join(homedir(), '.cache'), { recursive: true });
const root = mkdtempSync(join(homedir(), '.cache', 'pw-update-e2e-'));
let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'OK  ' : 'ÉCHEC'} ${msg}`);
  if (!cond) failures++;
};

const electronDir = dirname(realpathSync(createRequire(import.meta.url)('electron')));

/** `appImage` : AppImage factice de ce processus ; `flag` : option --update-feed-test (vrai par défaut). */
async function launch(name, extra, o = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, XDG_CONFIG_HOME: join(dir, 'config'), XDG_CACHE_HOME: join(dir, 'cache'), PROC_WATCH_NO_RECORDER_SYNC: '1' };
  for (const k of ['APPIMAGE', 'APPDIR', 'PROC_WATCH_UPDATE_FEED', 'APPIMAGE_SILENT_INSTALL']) delete env[k];
  Object.assign(env, extra);
  if (o.appImage) {
    const img = join(dir, 'proc-watch-0.1.0-x86_64.AppImage');
    // en-tête d'AppImage (ELF + « AI\x02 » à l'octet 8) exigé par realAppImage ; jamais exécuté
    writeFileSync(img, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 0x02]), Buffer.from(' factice : jamais exécuté')]));
    Object.assign(env, { APPIMAGE: img, APPDIR: electronDir });
  }
  const app = await electron.launch({ args: o.flag === false ? ['.'] : ['.', '--update-feed-test'], env });
  if (process.env.E2E_DEBUG) {
    app.process().stderr?.on('data', (b) => process.stderr.write(`[${name}] ${b}`));
    app.process().stdout?.on('data', (b) => process.stdout.write(`[${name}] ${b}`));
    const t0 = Date.now();
    app.process().on('exit', (c, sig) => console.log(`[${name}] sortie ${c} ${sig} après ${(Date.now() - t0) / 1000} s`));
  }
  const win = await app.firstWindow();
  await win.waitForSelector('[data-testid="snapshot-ready"]', { timeout: 20000 });
  // pop-up earlyoom éventuel (machine sans earlyoom) : « Plus tard », jamais d'installation
  const eo = win.locator('[data-testid="earlyoom-popup-later"]');
  await eo.waitFor({ timeout: 2000 }).then(() => eo.evaluate((el) => el.click()), () => {});
  return { app, win };
}
/**
 * Clic DOM : la fenêtre peut être cachée ou sur un autre bureau (Chromium suspend alors requestAnimationFrame et le clic
 * Playwright attend indéfiniment que l'élément soit « stable »).
 */
const press = async (loc) => {
  await loc.waitFor({ timeout: 10000 });
  await loc.evaluate((el) => el.click());
};
async function quit(app) {
  await app.evaluate(({ app }) => app.quit()).catch(() => {});
  await app.close().catch(() => {});
}
async function openAbout(win) {
  await press(win.locator('button[aria-label="Réglages"]'));
  await press(win.locator('[data-testid="settings-nav-about"]'));
  await win.waitForSelector('[data-testid="about-card"]', { timeout: 5000 });
}

try {
  // A. AppImage : vérification automatique (30 s), téléchargement vérifié, jamais d'installation
  {
    const t0 = Date.now();
    const { app, win } = await launch('a', { PROC_WATCH_UPDATE_FEED: feed }, { appImage: true });
    try {
      const popup = win.locator('[data-testid="update-popup"]');
      await popup.waitFor({ timeout: 45000 });
      const waited = (Date.now() - t0) / 1000;
      ok(waited >= 25, `A. pop-up après la vérification automatique (${waited.toFixed(1)} s après le lancement)`);
      ok((await popup.locator('strong').innerText()) === 'Mise à jour 9.9.9 disponible', 'A. titre « Mise à jour 9.9.9 disponible »');
      ok((await win.locator('[data-testid="update-popup-body"]').innerText()).includes('Notes de test : plus rapide.'), 'A. notes de version (HTML retiré)');
      ok(!hits.includes(`/${FILE}`), 'A. rien téléchargé avant « Mettre à jour »');
      for (const k of ['download', 'later', 'ignore']) ok(await win.locator(`[data-testid="update-popup-${k}"]`).isVisible(), `A. bouton ${k}`);
      await press(win.locator('[data-testid="update-popup-download"]'));
      await win.locator('[data-testid="update-popup-install"]').waitFor({ timeout: 20000 });
      ok(hits.includes(`/${FILE}`), 'A. fichier téléchargé après « Mettre à jour »');
      ok((await win.locator('[data-testid="update-popup-body"]').innerText()).includes('vérifiée'), 'A. prête : « Téléchargée et vérifiée », redémarrage expliqué');
      // « Redémarrer et installer » n'est jamais cliqué : aucune AppImage n'est remplacée ni lancée.
      await press(win.locator('[data-testid="update-popup-later"]'));
      await popup.waitFor({ state: 'detached', timeout: 5000 });
      ok(true, 'A. « Plus tard » ferme le pop-up');
      await openAbout(win);
      ok((await win.locator('[data-testid="about-version"]').innerText()) === '0.1.0', 'A. À propos : version 0.1.0');
      ok((await win.locator('[data-testid="about-last-check"]').innerText()).includes('9.9.9 disponible'), 'A. À propos : dernière vérification');
    } finally {
      await quit(app);
    }
  }
  // B. sha512 faux : erreur et « Réessayer » ; « Ignorer cette version » gardé
  {
    badSha = true;
    const { app, win } = await launch('b', { PROC_WATCH_UPDATE_FEED: feed }, { appImage: true });
    try {
      await openAbout(win);
      await press(win.locator('[data-testid="about-check-now"]'));
      await win.locator('[data-testid="update-popup"]').waitFor({ timeout: 15000 });
      await press(win.locator('[data-testid="update-popup-download"]'));
      await win.locator('[data-testid="update-popup-retry"]', { hasText: 'Réessayer' }).waitFor({ timeout: 20000 });
      const body = await win.locator('[data-testid="update-popup-body"]').innerText();
      ok(/Échec du téléchargement/.test(body) && /sha512/i.test(body), `B. sha512 refusé : « ${body.slice(0, 120)} »`);
    } finally {
      await quit(app);
    }
    badSha = false;
    const again = await launch('b2', { PROC_WATCH_UPDATE_FEED: feed }, { appImage: true });
    try {
      await openAbout(again.win);
      await press(again.win.locator('[data-testid="about-check-now"]'));
      await press(again.win.locator('[data-testid="update-popup-ignore"]'));
      await again.win.locator('[data-testid="update-popup"]').waitFor({ state: 'detached', timeout: 5000 });
      await press(again.win.locator('[data-testid="about-check-now"]'));
      await again.win.waitForTimeout(1500);
      ok((await again.win.locator('[data-testid="update-popup"]').count()) === 0, 'B. version ignorée : plus de pop-up à la vérification suivante');
      ok((await again.win.locator('[data-testid="about-last-check"]').innerText()).includes('9.9.9 ignorée'), 'B. À propos : version ignorée affichée');
    } finally {
      await quit(again.app);
    }
  }
  // C. pas une AppImage : notification seulement
  {
    const before = hits.filter((h) => h === `/${FILE}`).length;
    const { app, win } = await launch('c', { PROC_WATCH_UPDATE_FEED: feed });
    try {
      await openAbout(win);
      await press(win.locator('[data-testid="about-check-now"]'));
      await win.locator('[data-testid="update-popup"]').waitFor({ timeout: 15000 });
      ok(await win.locator('[data-testid="update-popup-open"]').isVisible(), 'C. « Voir la version »');
      ok((await win.locator('[data-testid="update-popup-download"]').count()) === 0, 'C. aucun bouton de téléchargement');
      ok((await win.locator('[data-testid="update-popup-body"]').innerText()).includes('une mise à jour est disponible'), 'C. texte de notification');
      ok(hits.includes('/releases.json'), 'C. version lue par la liste des versions (API)');
      ok(hits.filter((h) => h === `/${FILE}`).length === before, 'C. rien téléchargé');
    } finally {
      await quit(app);
    }
  }
  // D. sources sans flux : aucune vérification
  {
    const before = hits.length;
    const { app, win } = await launch('d', {});
    try {
      await openAbout(win);
      ok((await win.locator('[data-testid="about-card"]').innerText()).includes('aucune vérification'), 'D. À propos : « aucune vérification »');
      ok(await win.locator('[data-testid="about-check-now"]').isDisabled(), 'D. « Vérifier maintenant » désactivé');
      ok(hits.length === before, 'D. aucune requête');
    } finally {
      await quit(app);
    }
  }
  // E. APPIMAGE / APPDIR hérités d'une autre application (terminal d'un éditeur en AppImage) : notification seulement
  {
    const other = join(root, 'Editeur-1.2.3.AppImage');
    writeFileSync(other, 'autre application');
    const otherMount = join(root, '.mount_Editeur');
    mkdirSync(otherMount, { recursive: true });
    const { app, win } = await launch('e', { PROC_WATCH_UPDATE_FEED: feed, APPIMAGE: other, APPDIR: otherMount });
    try {
      await openAbout(win);
      ok((await win.locator('[data-testid="about-card"]').innerText()).includes('Paquet (.deb)'), 'E. APPIMAGE hérité : pas le mode AppImage');
      await press(win.locator('[data-testid="about-check-now"]'));
      await win.locator('[data-testid="update-popup"]').waitFor({ timeout: 15000 });
      ok((await win.locator('[data-testid="update-popup-download"]').count()) === 0, 'E. aucun bouton de téléchargement (l’autre AppImage ne peut pas être remplacée)');
    } finally {
      await quit(app);
    }
  }
  // F. copie installée présente, AppImage téléchargée lancée : on ne met pas à jour l'original
  {
    const home = join(root, 'f-home');
    mkdirSync(join(home, 'Applications'), { recursive: true });
    writeFileSync(join(home, 'Applications', 'proc-watch.AppImage'), 'copie installée');
    const before = hits.filter((h) => h === `/${FILE}`).length;
    const { app, win } = await launch('f', { PROC_WATCH_UPDATE_FEED: feed, HOME: home }, { appImage: true });
    try {
      await openAbout(win);
      await press(win.locator('[data-testid="about-check-now"]'));
      await win.locator('[data-testid="update-popup"]').waitFor({ timeout: 15000 });
      ok((await win.locator('[data-testid="update-popup-body"]').innerText()).includes('lancez proc-watch depuis le menu pour mettre à jour'), 'F. « lancez proc-watch depuis le menu pour mettre à jour »');
      ok((await win.locator('[data-testid="update-popup-download"]').count()) === 0, 'F. aucun bouton de téléchargement');
      ok(hits.filter((h) => h === `/${FILE}`).length === before, 'F. rien téléchargé');
    } finally {
      await quit(app);
    }
  }
  // G. variable seule, sans l'option --update-feed-test : ignorée
  {
    const before = hits.length;
    const { app, win } = await launch('g', { PROC_WATCH_UPDATE_FEED: feed }, { appImage: true, flag: false });
    try {
      await openAbout(win);
      ok((await win.locator('[data-testid="about-card"]').innerText()).includes('aucune vérification'), 'G. sans --update-feed-test : aucune vérification');
      ok(hits.length === before, 'G. aucune requête');
    } finally {
      await quit(app);
    }
  }
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} échec(s)` : '\nUPDATE E2E OK');
process.exitCode = failures ? 1 : 0;
