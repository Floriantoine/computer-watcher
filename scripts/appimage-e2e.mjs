// Bout en bout avec une VRAIE AppImage (construite localement, flux de mise à jour local à jeton) :
// accueil, installation dans $HOME/Applications, relance de la copie et suppression du fichier téléchargé, démarrage
// automatique, mise à jour 0.1.0 → 0.1.1 de la copie installée, désinstallation (unité gardée sous NO_RECORDER_SYNC).
// Racines temporaires HOME / XDG_* sous ~/.cache/pw-appimage-e2e-*, PROC_WATCH_NO_RECORDER_SYNC=1, supprimées à la fin.
//
// Préparation (dossier de build B hors du dépôt, port P, jeton T d'au moins 32 caractères) :
//   copie de electron-builder.yml dans B/eb.yml avec « publish: { provider: generic, url: http://127.0.0.1:P/T/ } »
//   npx electron-vite build
//   npx electron-builder --linux AppImage --publish never --config B/eb.yml -c.directories.output=B/v010
//   npx electron-builder --linux AppImage --publish never --config B/eb.yml -c.directories.output=B/v011 -c.extraMetadata.version=0.1.1
// Usage : node scripts/appimage-e2e.mjs <dépôt> <B> <P> <T> <dossier de captures hors du dépôt>
// Ces AppImages de test pointent vers le flux local : ne jamais les publier.
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [wt, build, port, token, shots] = process.argv.slice(2);
const { _electron: electron } = createRequire(join(wt, 'package.json'))('playwright');
mkdirSync(shots, { recursive: true });
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, m) => {
  console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`);
  if (!c) failures++;
};
const report = {};

const V010 = join(build, 'v010/proc-watch-0.1.0-x86_64.AppImage');
const V011 = join(build, 'v011/proc-watch-0.1.1-x86_64.AppImage');

// flux local : seulement sous /<jeton>/
const hits = [];
const server = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  hits.push(p);
  if (!p.startsWith(`/${token}/`)) return void res.writeHead(404).end();
  const name = p.slice(token.length + 2);
  const file = name === 'latest-linux.yml' ? join(build, 'v011/latest-linux.yml') : name === 'proc-watch-0.1.1-x86_64.AppImage' ? V011 : null;
  if (!file) return void res.writeHead(404).end();
  const body = readFileSync(file);
  res.writeHead(200, { 'content-length': body.length }).end(body);
});
await new Promise((r) => server.listen(Number(port), '127.0.0.1', r));

/** Montages proc-watch déjà présents avant le test : jamais touchés. */
const preMounts = new Set(readFileSync('/proc/self/mountinfo', 'utf8').split('\n').map((l) => l.split(' ')[4]).filter((m) => m && m.startsWith('/tmp/.mount_proc-w')));
console.log('montages proc-watch préexistants :', preMounts.size);
const base = mkdtempSync(join(homedir(), '.cache', 'pw-appimage-e2e-'));
const home = join(base, 'home');
const cfg = join(base, 'cfg');
const data = join(base, 'data');
const dl = join(home, 'Téléchargements');
mkdirSync(dl, { recursive: true });
const downloaded = join(dl, 'proc-watch-0.1.0-x86_64.AppImage');
copyFileSync(V010, downloaded);
chmodSync(downloaded, 0o755);
const copy = join(home, 'Applications/proc-watch.AppImage');
const unit = join(cfg, 'systemd/user/proc-watch-recorder.service');
mkdirSync(join(cfg, 'systemd/user'), { recursive: true });
writeFileSync(unit, '[Unit]\nDescription=unité factice du test (jamais chargée)\n');

const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: data, XDG_CACHE_HOME: join(base, 'cache'), PROC_WATCH_NO_RECORDER_SYNC: '1' };
for (const k of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'PROC_WATCH_UPDATE_FEED', 'ELECTRON_RUN_AS_NODE']) delete env[k];

/**
 * Nos processus seulement : HOME de l'environnement = le HOME temporaire (runtimes AppImage), plus leurs descendants
 * (Chromium rend /proc/<pid>/environ illisible pour ses processus).
 */
function ours() {
  const all = [];
  for (const e of readdirSync('/proc')) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const stat = readFileSync(`/proc/${e}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      let mine = false;
      try {
        mine = readFileSync(`/proc/${e}/environ`, 'utf8').split('\0').includes(`HOME=${home}`);
      } catch {}
      const cmd = (() => { try { return readFileSync(`/proc/${e}/cmdline`, 'utf8').split('\0')[0]; } catch { return ''; } })();
      all.push({ pid: Number(e), ppid, mine, exe: (() => { try { return readlinkSync(`/proc/${e}/exe`); } catch { return cmd || '?'; } })() });
    } catch {}
  }
  const set = new Set(all.filter((p) => p.mine).map((p) => p.pid));
  const byPid = new Map(all.map((p) => [p.pid, p]));
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of all) if (!set.has(p.pid) && set.has(p.ppid)) { set.add(p.pid); changed = true; }
    // le runtime AppImage remplace son processus par l'app (exec) : le démon FUSE (lisible) en est l'enfant
    for (const pid of [...set]) {
      const parent = byPid.get(byPid.get(pid)?.ppid);
      if (parent && !set.has(parent.pid) && parent.exe.includes('/.mount_proc-w')) { set.add(parent.pid); changed = true; }
    }
  }
  // processus de l'app sous un montage proc-watch apparu pendant le test (Chromium rend exe/environ illisibles, pas cmdline)
  for (const p of all) {
    const m = /^(\/tmp\/\.mount_proc-w[^/]+)\//.exec(p.exe);
    if (m && !preMounts.has(m[1])) set.add(p.pid);
  }
  return all.filter((p) => set.has(p.pid)).map(({ pid, exe }) => ({ pid, exe }));
}
async function killOurs() {
  for (let i = 0; i < 50; i++) {
    const ps = ours().filter((p) => p.pid !== process.pid);
    if (!ps.length) return;
    for (const p of ps) {
      try {
        process.kill(p.pid, i < 30 ? 'SIGTERM' : 'SIGKILL');
      } catch {}
    }
    await sleep(200);
  }
}
async function waitFor(fn, ms, step = 250) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}
async function launch(exe) {
  const app = await electron.launch({ executablePath: exe, args: [], env, timeout: 60000 });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win };
}
const mountOf = (app) => app.evaluate(() => process.getBuiltinModule('fs').readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter((l) => l.includes(process.env.APPDIR)));
const stubDialogs = (app) => app.evaluate(({ dialog }) => {
  dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); // le test consent à la place de l'utilisateur
});
const exited = (app) => new Promise((r) => app.process().once('exit', r));

try {
  // ---------------------------------------------------------------- A. lancée depuis Téléchargements
  {
    const { app, win } = await launch(downloaded);
    const info = await app.evaluate(() => {
      const fs = process.getBuiltinModule('fs');
      const mi = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter((l) => l.includes(process.env.APPDIR));
      return { APPIMAGE: process.env.APPIMAGE, APPDIR: process.env.APPDIR, exe: fs.realpathSync('/proc/self/exe'), mount: mi };
    });
    report.launch = info;
    console.log('mountinfo:', info.mount.join('\n'));
    ok(info.APPIMAGE === downloaded, `A. APPIMAGE = fichier téléchargé (${info.APPIMAGE})`);
    await win.locator('[data-testid="onboarding"]').waitFor({ timeout: 20000 });
    ok(true, 'A. assistant d’accueil affiché (config neuve)');
    ok((await win.locator('[data-testid="onb-step-install"]').count()) === 1, 'A. étape « Installer comme une app » présente (realAppImage accepte la vraie AppImage)');
    await win.locator('[data-testid="onboarding"]').screenshot({ path: join(shots, 'a1-install.png') });
    await win.locator('[data-testid="onb-install"]').click();
    await win.locator('[data-testid="onb-install-result"]').waitFor({ timeout: 60000 });
    const res = await win.locator('[data-testid="onb-install-result"]').innerText();
    console.log('résultat :', res.replace(/\n/g, ' | '));
    await win.locator('[data-testid="onboarding"]').screenshot({ path: join(shots, 'a2-install-result.png') });
    ok(existsSync(copy) && sha(copy) === sha(downloaded), 'A. copie dans $HOME/Applications, identique');
    ok((statSync(copy).mode & 0o777) === 0o755, 'A. copie en 0755');
    const entry = readFileSync(join(data, 'applications/proc-watch.desktop'), 'utf8');
    ok(entry.includes(`Exec="${copy}"`) && entry.includes('X-ProcWatch-Managed=1'), 'A. entrée de menu vers la copie, marquée');
    ok(existsSync(join(data, 'icons/hicolor/512x512/apps/proc-watch.png')), 'A. icône écrite');
    await stubDialogs(app);
    await win.locator('[data-testid="onb-delete-original"]').check();
    const gone = exited(app);
    await win.locator('[data-testid="onb-relaunch"]').click();
    await Promise.race([gone, sleep(20000)]);
    ok(true, 'A. instance téléchargée quittée');
    const deleted = await waitFor(() => !existsSync(downloaded), 60000);
    ok(deleted, 'B. copie relancée : fichier téléchargé supprimé par l’accord');
    const relaunched = ours();
    report.relaunched = relaunched;
    ok(relaunched.some((p) => p.exe === copy) && relaunched.some((p) => p.exe.includes('/.mount_proc-w')), 'B. la copie relancée tourne (runtime = la copie, app sous son montage)');
    // I-A : la copie relancée ne reçoit rien qui pointe dans le montage /tmp de l'AppImage qui quitte
    const rt = relaunched.find((p) => p.exe === copy);
    const rtEnv = rt ? readFileSync(`/proc/${rt.pid}/environ`, 'utf8') : '';
    ok(!!rt && !rtEnv.includes('/tmp/.mount_'), 'B. environnement de la copie relancée : aucune entrée sous /tmp/.mount_ (PATH, LD_LIBRARY_PATH…)');
    const ob = JSON.parse(readFileSync(join(cfg, 'proc-watch/onboarding.json'), 'utf8'));
    ok(!('deleteOriginal' in ob) && ob.resume === 'autostart', `B. accord consommé, reprise à « Démarrer avec la session » (${JSON.stringify(ob)})`);
    await killOurs();
    ok(ours().length === 0, 'B. copie relancée arrêtée (par PID)');
  }

  // ---------------------------------------------------------------- C. copie : démarrage auto, mise à jour
  {
    const { app, win } = await launch(copy);
    const env2 = await app.evaluate(() => ({ APPIMAGE: process.env.APPIMAGE }));
    report.mountCopy = await mountOf(app);
    console.log('mountinfo (copie) :', report.mountCopy.join(' / '));
    ok(env2.APPIMAGE === copy, `C. APPIMAGE = la copie (${env2.APPIMAGE})`);
    await win.locator('[data-testid="onb-content-autostart"]').waitFor({ timeout: 20000 });
    ok(true, 'C. accueil repris à « Démarrer avec la session »');
    await win.locator('[data-testid="onboarding"]').screenshot({ path: join(shots, 'c1-autostart.png') });
    await win.locator('[data-testid="onb-next"]').click();
    await win.locator('[data-testid="onb-content-history"]').waitFor({ timeout: 10000 });
    const auto = readFileSync(join(cfg, 'autostart/proc-watch.desktop'), 'utf8');
    ok(auto.includes(`Exec="${copy}" --hidden`) && auto.includes('X-ProcWatch-Managed=1'), 'C. démarrage auto : copie --hidden, marqué');
    await win.keyboard.press('Escape');
    await win.locator('[data-testid="onboarding"]').waitFor({ state: 'detached', timeout: 10000 });
    const about = await win.evaluate(() => window.procWatch.about.info());
    ok(about.installedCopy === copy && about.appImage === copy && about.version === '0.1.0', `C. À propos : copie installée, version ${about.version}`);
    // mise à jour depuis le flux local
    const before = sha(copy);
    let v = await win.evaluate(() => window.procWatch.update.check());
    ok(v.state.mode === 'install' && v.state.phase === 'available' && v.state.available?.version === '0.1.1', `C. mise à jour 0.1.1 proposée (mode ${v.state.mode}, phase ${v.state.phase})`);
    await win.evaluate(() => window.procWatch.update.download());
    const ready = await waitFor(async () => (await win.evaluate(() => window.procWatch.update.get())).state.phase === 'ready', 120000, 500);
    ok(ready, 'C. 0.1.1 téléchargée et vérifiée (sha512)');
    const gone = exited(app);
    await win.evaluate(() => window.procWatch.update.install()).catch(() => {});
    await Promise.race([gone, sleep(30000)]);
    const replaced = await waitFor(() => existsSync(copy) && statSync(copy).size > 0 && sha(copy) === sha(V011), 60000);
    ok(replaced, 'C. la copie de $HOME/Applications est remplacée par la 0.1.1, sur place');
    ok(sha(copy) !== before, 'C. contenu changé');
    ok(readdirSync(join(home, 'Applications')).join(',') === 'proc-watch.AppImage', `C. un seul fichier dans Applications (${readdirSync(join(home, 'Applications')).join(',')})`);
    ok(readdirSync(dl).length === 0, 'C. rien dans Téléchargements');
    report.afterUpdate = ours();
    await killOurs();
  }

  // ---------------------------------------------------------------- D. désinstallation
  {
    const { app, win } = await launch(copy);
    ok((await win.evaluate(() => window.procWatch.about.info())).version === '0.1.1', 'D. la copie est bien la 0.1.1');
    report.mountUpdated = await mountOf(app);
    console.log('mountinfo (copie mise à jour) :', report.mountUpdated.join(' / '));
    ok((await win.locator('[data-testid="onboarding"]').count()) === 0, 'D. accueil fait : plus d’assistant');
    await stubDialogs(app);
    ok(existsSync(join(base, 'cache/proc-watch-updater')), 'D. cache de l’updater présent après la mise à jour');
    const r1 = await win.evaluate(() => window.procWatch.uninstall.run({ history: true, config: true }));
    console.log('désinstallation 1 :', JSON.stringify(r1.result, null, 1));
    ok(!existsSync(join(base, 'cache/proc-watch-updater')), 'D. cache de l’updater retiré (configuration cochée)');
    for (const p of [join(cfg, 'autostart/proc-watch.desktop'), join(data, 'applications/proc-watch.desktop'), join(data, 'icons/hicolor/512x512/apps/proc-watch.png')])
      ok(!existsSync(p), `D. retiré : ${p.slice(base.length)}`);
    ok(existsSync(unit) && r1.result.kept.some((k) => k.path === unit && /PROC_WATCH_NO_RECORDER_SYNC/.test(k.reason)), 'D. unité gardée (NO_RECORDER_SYNC), et dit');
    ok(existsSync(copy) && !r1.result.done, 'D. copie gardée tant que l’unité reste (réessayer)');
    // le test retire l'unité factice (jamais chargée), puis réessaie : tout part, l'app quitte
    rmSync(unit);
    console.log('config avant le 2e passage :', existsSync(join(cfg, 'proc-watch')) ? readdirSync(join(cfg, 'proc-watch')).join(' | ') : '(retirée)');
    const gone = exited(app);
    const r2 = await win.evaluate(() => window.procWatch.uninstall.run({ history: true, config: true }));
    console.log('désinstallation 2 :', JSON.stringify(r2.result));
    ok(r2.result.done, 'D. deuxième passage : tout retiré');
    ok(!existsSync(copy), 'D. copie retirée en dernier');
    ok(await Promise.race([gone.then(() => true), sleep(15000).then(() => false)]), 'D. l’app quitte');
    const tExit = Date.now();
    await sleep(2000);
    if (existsSync(join(cfg, 'proc-watch'))) {
      const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => { const f = join(d, e.name); return [`${f.slice(cfg.length)} ${Math.round(statSync(f).mtimeMs - tExit)}ms`, ...(e.isDirectory() ? walk(f) : [])]; });
      console.log('reste :', walk(join(cfg, 'proc-watch')).join(' | '));
    }
    ok(!existsSync(join(cfg, 'proc-watch')), `D. configuration retirée (${existsSync(join(cfg, 'proc-watch')) ? readdirSync(join(cfg, 'proc-watch')).join(' | ') : ''})`);
    await killOurs();
  }
} catch (e) {
  failures++;
  console.error('ERREUR', e);
} finally {
  await killOurs();
  server.close();
  console.log('requêtes au flux :', [...new Set(hits.map((h) => h.replace(token, '<jeton>')))].join(' '));
  writeFileSync(join(shots, 'report.json'), JSON.stringify(report, null, 1));
  rmSync(base, { recursive: true, force: true });
  console.log('nettoyé :', !existsSync(base), '| processus restants :', ours().length);
  console.log(failures ? `ÉCHECS : ${failures}` : 'APPIMAGE E2E OK');
  process.exit(failures ? 1 : 0);
}
