// Page Disque de bout en bout : onglet, bandes, soleil, familles, « Libérer… » sur des caches factices.
// Usage : npm run build && node scripts/disk-page-e2e.mjs
//
// Rien de réel n'est touché : HOME et XDG_* temporaires sous ~/.cache/pw-disk-page-* (faux caches npm, uv, Playwright,
// un dossier « précieux » et ~/.cache/pip qui pointe dessus), config et données temporaires (jamais la vraie metrics.db),
// service systemd laissé tranquille (PROC_WATCH_NO_RECORDER_SYNC), pkexec simulé (PROC_WATCH_DISK_ROOT_FAKE, hors paquet
// seulement : aucune famille root n'est d'ailleurs cochée). La boîte de confirmation native est remplacée, dans le main,
// par une réponse « Supprimer définitivement » enregistrée. Captures seulement si DISK_PAGE_SHOTS désigne un dossier
// (hors du dépôt).
//
// Lot 2 : faux dépôt git et worktrees (config git de l'utilisateur jamais lue), faux node_modules (dont une vraie archive
// .asar, supprimée en entier sous Electron), caches d'applis et dossier inconnu de ~/.cache, Docker simulé par
// PROC_WATCH_DISK_DOCKER_FAKE (aucun processus docker lancé, hors paquet seulement).
import { createPackage } from '@electron/asar';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

mkdirSync(join(homedir(), '.cache'), { recursive: true });
const base = realpathSync(mkdtempSync(join(homedir(), '.cache', 'pw-disk-page-')));
// dossier temporaire supprimé à la fin, même en cas d'échec ou d'interruption (timeout, Ctrl+C)
const cleanup = () => rmSync(base, { recursive: true, force: true });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });
let app = null;
try {
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
  fill(join(home, '.npm/_cacache/index-v5/aa/entree'), 4); // signature de npm
  fill(join(home, '.npm/_logs/garde.log'), 16);
  fill(join(cache, 'uv/wheels-v5/roue.whl'), 3 * 1024);
  fill(join(cache, 'uv/CACHEDIR.TAG'), 1); // signature de uv
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

  // lot 2 : dossiers de projets factices (réglage ui.diskProjectRoots posé après le lancement)
  const DAY = 86_400_000;
  const ageTree = (dir, days) => {
    const t = new Date(Date.now() - days * DAY);
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        const st = lstatSync(p);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) walk(p);
        utimesSync(p, t, t);
      }
    };
    walk(dir);
  };
  // vraie archive .asar (revue, point 1) : sous Electron, fs la lirait comme un dossier ; elle doit partir avec son dossier
  const asarSrc = join(base, 'asar-src');
  fill(join(asarSrc, 'index.js'), 4);
  fill(join(asarSrc, 'lib/module.js'), 8);
  const asarIn = async (dest) => {
    mkdirSync(join(dest, '..'), { recursive: true });
    await createPackage(asarSrc, dest);
    assert.ok(lstatSync(dest).isFile(), `${dest} : archive créée`);
  };
  const code = join(home, 'code');
  fill(join(code, 'vieux-projet/package.json'), 1);
  fill(join(code, 'vieux-projet/node_modules/dep/index.js'), 2 * 1024);
  await asarIn(join(code, 'vieux-projet/node_modules/electron/dist/resources/default_app.asar'));
  ageTree(join(code, 'vieux-projet'), 40);
  fill(join(code, 'projet-actif/package.json'), 1);
  fill(join(code, 'projet-actif/node_modules/dep/index.js'), 1024);
  ageTree(join(code, 'projet-actif'), 40);
  fill(join(code, 'projet-actif/src/app.ts'), 1); // modifié maintenant : projet actif
  // dépôt git et worktrees : config git de l'utilisateur jamais lue
  const GIT = existsSync('/usr/bin/git') ? '/usr/bin/git' : '/bin/git';
  const gitEnv = {
    PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const git = (cwd, ...args) => execFileSync(GIT, args, { cwd, env: gitEnv, encoding: 'utf8' });
  const depot = join(code, 'depot');
  mkdirSync(depot, { recursive: true });
  git(depot, 'init', '-q', '-b', 'main');
  writeFileSync(join(depot, '.gitignore'), 'node_modules/\n.env\n');
  writeFileSync(join(depot, 'a.txt'), 'a');
  git(depot, 'add', '.');
  git(depot, 'commit', '-qm', 'init');
  const wt = (name, o = {}) => {
    const p = join(depot, '.worktrees', name);
    if (o.detached) git(depot, 'worktree', 'add', '-q', '--detach', p);
    else {
      git(depot, 'worktree', 'add', '-q', '-b', name, p);
      writeFileSync(join(p, `${name}.txt`), name);
      git(p, 'add', '.');
      git(p, 'commit', '-qm', name);
      if (o.merged) git(depot, 'merge', '-q', '--ff-only', name);
    }
    return p;
  };
  const wtFini = wt('fini', { merged: true });
  fill(join(wtFini, 'node_modules/dep/index.js'), 1024); // ignoré par git, reconstructible : ne bloque pas
  const wtEncours = wt('encours');
  const wtStable = wt('stable-test', { detached: true });
  const wtGarde = wt('garde', { merged: true });
  git(depot, 'worktree', 'lock', wtGarde);
  const wtSale = wt('sale', { merged: true });
  const wtSecret = wt('secret', { merged: true });
  for (const p of [wtFini, wtEncours, wtStable, wtGarde, wtSale, wtSecret]) ageTree(p, 3);
  writeFileSync(join(wtSale, 'non-suivi.txt'), 'x');
  writeFileSync(join(wtSecret, '.env'), 'JETON=factice');
  // cache d'appli (profil à côté, jamais touché) et dossier inconnu de ~/.cache (avec une archive .asar)
  fill(join(cache, 'google-chrome/Default/Cache/Cache_Data/f_000001'), 1024);
  fill(join(cfg, 'google-chrome/Default/Preferences'), 1);
  fill(join(cache, 'outil-inconnu/blob'), 2 * 1024);
  await asarIn(join(cache, 'outil-inconnu/paquet.asar'));

  const shots = process.env.DISK_PAGE_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  const shot = async (win, name) => shots && win.screenshot({ path: join(shots, `${name}.png`) });

  const env = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: data, XDG_CACHE_HOME: cache, XDG_STATE_HOME: join(base, 'state'),
    PROC_WATCH_NO_RECORDER_SYNC: '1', PROC_WATCH_NO_ANTIGEL: '1', PROC_WATCH_DISK_ROOT_FAKE: '1', PROC_WATCH_DISK_DOCKER_FAKE: '1',
    // earlyoom simulé (dossier vide : rien à proposer) : aucun pop-up earlyoom selon l'état réel de la machine
    PROC_WATCH_EARLYOOM_FAKE: join(base, 'earlyoom'),
  };
  mkdirSync(env.PROC_WATCH_EARLYOOM_FAKE);
  app = await electron.launch({ args: ['.'], env });
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

  // dossiers de projets du lot 2 : réglage posé avant d'ouvrir la page
  const st0 = await win.evaluate(() => window.procWatch.getConfig());
  await win.evaluate((c) => window.procWatch.setConfig(c), { ...st0.config, ui: { ...st0.config.ui, diskProjectRoots: [code] } });

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
  // chemins exacts et taille de chacun (revue I1 c) ; la dernière version du navigateur n'y est pas
  assert.ok(confirms[0].detail.includes(`${join(home, '.npm/_cacache')} (`), 'chemin npm dans la confirmation');
  assert.ok(confirms[0].detail.includes(`${join(cache, 'ms-playwright/chromium-1140')} (`), 'version retirée dans la confirmation');
  assert.ok(!confirms[0].detail.includes('chromium-1155'), 'version gardée absente de la confirmation');
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

  // 8) lot 2 : node_modules inactifs, worktrees fusionnés, cache d'appli, dossier inconnu, Docker simulé
  const waitFor = async (fn, ms = 30000) => {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error('délai dépassé');
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  const nmRow = (p) => win.locator(`[data-testid="disk-nm-row"][data-key="${p}"]`);
  const wtRow = (p) => win.locator(`[data-testid="disk-wt-row"][data-key="${p}"]`);
  const cacheRow = (n) => win.locator(`[data-testid="disk-cache-row"][data-key="${n}"]`);
  const dockRow = (a) => win.locator(`[data-testid="disk-docker-row"][data-key="${a}"]`);
  const nmVieux = join(code, 'vieux-projet/node_modules');
  await nmRow(nmVieux).waitFor({ timeout: 60000 });
  assert.match(await nmRow(nmVieux).innerText(), /historique partiel/);
  assert.equal(await nmRow(join(code, 'projet-actif/node_modules')).count(), 0, 'projet actif jamais proposé');
  await wtRow(wtFini).waitFor();
  assert.equal(await wtRow(wtFini).locator('input').isDisabled(), false);
  assert.match(await wtRow(wtSale).innerText(), /non suivis/);
  assert.equal(await wtRow(wtSale).locator('input').isDisabled(), true);
  assert.match(await wtRow(wtSecret).innerText(), /fichiers ignorés qui seraient perdus : \.env/);
  assert.equal(await wtRow(wtSecret).locator('input').isDisabled(), true);
  for (const p of [wtEncours, wtStable, wtGarde, depot]) assert.equal(await wtRow(p).count(), 0, `${p} jamais proposé`);
  assert.match(await cacheRow('outil-inconnu').innerText(), /inconnu : vérifie avant/);
  for (const n of ['google-chrome', 'uv', 'ms-playwright']) assert.equal(await cacheRow(n).count(), 0, `${n} : famille connue, pas dans l’explorateur`);
  await row('app-chrome').waitFor();
  for (const a of ['images', 'containers', 'volumes']) assert.equal(await dockRow(a).count(), 1, `Docker ${a}`);
  await shot(win, 'disque-lot2');

  await app.evaluate(() => {
    globalThis.__diskConfirms = [];
    globalThis.__pwDockerFakeCalls = [];
  });
  await nmRow(nmVieux).locator('input').check();
  await wtRow(wtFini).locator('input').check();
  await cacheRow('outil-inconnu').locator('input').check();
  await row('app-chrome').locator('input').check();
  await dockRow('images').locator('input').check();
  await shot(win, 'disque-lot2-selection');
  await win.locator('[data-testid="disk-free-button"]').click();
  const evPath = join(data, 'computer-watcher', 'app-events.jsonl');
  const ev2 = await waitFor(() => {
    const all = readFileSync(evPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'disk_clean');
    return all.find((e) => [...e.detail.done, ...e.detail.refused.map((x) => x.id)].includes(`worktree:${wtFini}`));
  });
  const confirms2 = await app.evaluate(() => globalThis.__diskConfirms);
  assert.equal(confirms2.length, 1, 'une seule confirmation pour tout le lot 2');
  const det = confirms2[0].detail;
  for (const s of [`node_modules de`, nmVieux, wtFini, 'git branch -d fini (jamais forcé)', 'inconnu : vérifie avant', 'docker image prune -a -f', 'demo/old:0.9', 'Cache de Chrome', 'définitif']) {
    assert.ok(det.includes(s), `confirmation : ${s}`);
  }
  assert.ok(!det.includes('demo/web:1.0 ('), 'image utilisée absente de la confirmation');
  const refused2 = new Map(ev2.detail.refused.map((x) => [x.id, x.reason]));
  assert.deepEqual([...refused2.keys()].filter((k) => k !== 'app-chrome'), [], `aucun refus inattendu : ${JSON.stringify(ev2.detail.refused)}`);
  // sur le disque (node_modules avec sa vraie archive .asar : tout le dossier est parti, rien hors de lui)
  assert.equal(existsSync(nmVieux), false, 'node_modules inactif supprimé, archive .asar comprise');
  assert.equal(existsSync(join(code, 'vieux-projet/package.json')), true);
  assert.equal(existsSync(join(code, 'projet-actif/node_modules/dep/index.js')), true);
  assert.equal(existsSync(join(asarSrc, 'lib/module.js')), true, 'source de l’archive intacte');
  assert.equal(existsSync(wtFini), false, 'worktree fusionné supprimé');
  assert.equal(git(depot, 'branch', '--list', 'fini'), '', 'branche fini supprimée par git branch -d');
  for (const p of [wtEncours, wtStable, wtGarde, wtSale, wtSecret]) assert.equal(existsSync(p), true, `${p} intact`);
  assert.equal(readFileSync(join(wtSecret, '.env'), 'utf8'), 'JETON=factice');
  assert.equal(existsSync(join(cache, 'outil-inconnu')), false, 'dossier inconnu supprimé, archive .asar comprise');
  assert.equal(existsSync(join(cache, 'vignettes/a.png')), true, 'dossier inconnu non coché intact');
  assert.equal(existsSync(join(cfg, 'google-chrome/Default/Preferences')), true, 'profil Chrome jamais touché');
  if (refused2.has('app-chrome')) {
    // un vrai Chrome ouvert sur la machine fait refuser la famille : le cache doit rester intact
    const m = /utilisé par .+ \(pid (\d+)\)/.exec(refused2.get('app-chrome'));
    assert.ok(m && existsSync(`/proc/${m[1]}`), `Chrome refusé seulement s’il tourne : ${refused2.get('app-chrome')}`);
    assert.equal(existsSync(join(cache, 'google-chrome/Default/Cache/Cache_Data/f_000001')), true);
    console.log(`note : app-chrome refusé (${refused2.get('app-chrome')}), laissé intact`);
  } else assert.equal(existsSync(join(cache, 'google-chrome')), false, 'cache Chrome supprimé');
  const dockerCalls = await app.evaluate(() => globalThis.__pwDockerFakeCalls);
  assert.deepEqual(dockerCalls.filter((a) => a[1] === 'prune'), [['image', 'prune', '-a', '-f']], 'une seule action Docker, argv figé');
  await shot(win, 'disque-lot2-libere');

  // 9) requêtes forgées : un chemin jamais proposé (projet actif) est refusé sans être touché ; un nom hors ~/.cache est rejeté
  const r9 = await win.evaluate((p) => window.procWatch.disk.clean({ families: [], nodeModules: [p], worktrees: [], cacheDirs: [], docker: [] }), join(code, 'projet-actif/node_modules'));
  assert.equal(r9.done.length, 0);
  assert.match(r9.refused[0]?.reason ?? '', /plus dans la liste/);
  assert.equal(existsSync(join(code, 'projet-actif/node_modules/dep/index.js')), true);
  await assert.rejects(win.evaluate(() => window.procWatch.disk.clean({ families: [], nodeModules: [], worktrees: [], cacheDirs: ['../.ssh'], docker: [] })));
  await assert.rejects(win.evaluate(() => window.procWatch.disk.clean({ families: [], nodeModules: [], worktrees: [], cacheDirs: [], docker: ['system'] })));

  console.log('DISK PAGE E2E OK');
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    await app.close().catch(() => {});
  }
  cleanup();
}
