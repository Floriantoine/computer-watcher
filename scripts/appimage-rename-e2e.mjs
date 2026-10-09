// Bout en bout du renommage avec de VRAIES AppImage : une v0.1.3 (construite depuis l'étiquette v0.1.3) installée
// « comme une app » (~/Applications/proc-watch.AppImage, menu, démarrage automatique, réglages, historique) se met à jour
// vers une 0.2.0 locale (cette branche) par le flux à jeton ; la 0.2.0 migre : dossiers, entrées, copie
// computer-watcher.AppImage, relance, suppression de l'ancienne copie. Puis désinstallation.
// Lancé par `npm run test:appimage-rename` (scripts/appimage-e2e.mjs --rename), depuis la racine du dépôt, après
// `electron-vite build`.
//
// Racines temporaires HOME / XDG_* (XDG_RUNTIME_DIR compris) sous ~/.cache/pw-rename-e2e-*, PROC_WATCH_NO_RECORDER_SYNC=1 et
// PROC_WATCH_NO_KILL=1 : jamais les vrais dossiers, le vrai service ni un vrai signal de règle. Processus arrêtés par PID.
// Construction (une fois) dans ~/.cache/pw-rename-build-* : source v0.1.3 par `git archive` (aucune modification du dépôt),
// node_modules du dépôt en lien (dépendances identiques), version 0.2.0 par -c.extraMetadata.version (rien n'est commité).
// RENAME_E2E_BUILD=<dossier> : réutilise une construction précédente (meta.json : port et jeton du flux) et la garde ;
// sinon le dossier de construction est supprimé à la fin. RENAME_E2E_SHOTS=<dossier hors du dépôt> : captures.
// Ces AppImage pointent vers le flux local : ne jamais les publier.
import { spawnSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const wt = process.cwd();
const { _electron: electron } = createRequire(join(wt, 'package.json'))('playwright');
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, m) => {
  console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`);
  if (!c) failures++;
};
const shots = process.env.RENAME_E2E_SHOTS || null;
if (shots) mkdirSync(shots, { recursive: true });

// ---------------------------------------------------------------- construction des deux AppImage (une fois)
const keepBuild = !!process.env.RENAME_E2E_BUILD;
const build = process.env.RENAME_E2E_BUILD || mkdtempSync(join(homedir(), '.cache', 'pw-rename-build-'));
const run = (cmd, args, cwd) => {
  console.log(`$ (${cwd}) ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
  if (r.status !== 0) throw new Error(`échec : ${cmd} ${args.join(' ')} (code ${r.status})`);
};
const withFeed = (yml, url) => `${yml.replace(/^publish:\n(?: {2}.*\n?)*/m, '')}\npublish:\n  provider: generic\n  url: ${url}\n`;
let meta;
if (existsSync(join(build, 'meta.json'))) meta = JSON.parse(readFileSync(join(build, 'meta.json'), 'utf8'));
else {
  meta = { port: 20000 + Math.floor(Math.random() * 30000), token: randomBytes(24).toString('hex') };
  const feed = `http://127.0.0.1:${meta.port}/${meta.token}/`;
  const src = join(build, 'src-v0.1.3');
  mkdirSync(src);
  run('git', ['-C', wt, 'archive', '--format=tar', '-o', join(build, 'v0.1.3.tar'), 'v0.1.3'], wt);
  run('tar', ['-xf', join(build, 'v0.1.3.tar'), '-C', src], wt);
  symlinkSync(realpathSync(join(wt, 'node_modules')), join(src, 'node_modules'));
  writeFileSync(join(build, 'eb-v0.1.3.yml'), withFeed(readFileSync(join(src, 'electron-builder.yml'), 'utf8'), feed));
  writeFileSync(join(build, 'eb-v0.2.0.yml'), withFeed(readFileSync(join(wt, 'electron-builder.yml'), 'utf8'), feed));
  run('npx', ['electron-vite', 'build'], src);
  run('npx', ['electron-builder', '--linux', 'AppImage', '--publish', 'never', '--config', join(build, 'eb-v0.1.3.yml'), `-c.directories.output=${join(build, 'v0.1.3')}`], src);
  run('npx', ['electron-builder', '--linux', 'AppImage', '--publish', 'never', '--config', join(build, 'eb-v0.2.0.yml'), `-c.directories.output=${join(build, 'v0.2.0')}`, '-c.extraMetadata.version=0.2.0'], wt);
  writeFileSync(join(build, 'meta.json'), JSON.stringify(meta));
}
const V013 = join(build, 'v0.1.3/proc-watch-0.1.3-x86_64.AppImage');
const V020_NAME = 'computer-watcher-0.2.0-x86_64.AppImage';
const V020 = join(build, 'v0.2.0', V020_NAME);
ok(existsSync(V013), `construction : ${V013.slice(build.length)}`);
ok(existsSync(V020), `construction : ${V020.slice(build.length)} (nom de fichier publié au nouveau nom)`);
const latest = readFileSync(join(build, 'v0.2.0/latest-linux.yml'), 'utf8');
ok(latest.includes(`url: ${V020_NAME}`) && /^version: 0\.2\.0$/m.test(latest), 'construction : latest-linux.yml cite computer-watcher-0.2.0-x86_64.AppImage');

// ---------------------------------------------------------------- flux local : seulement sous /<jeton>/
const hits = [];
const server = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  hits.push(p);
  if (!p.startsWith(`/${meta.token}/`)) return void res.writeHead(404).end();
  const name = p.slice(meta.token.length + 2);
  const file = name === 'latest-linux.yml' ? join(build, 'v0.2.0/latest-linux.yml') : name === V020_NAME ? V020 : null;
  if (!file) return void res.writeHead(404).end();
  const body = readFileSync(file);
  res.writeHead(200, { 'content-length': body.length }).end(body);
});
await new Promise((r) => server.listen(meta.port, '127.0.0.1', r));

// ---------------------------------------------------------------- racines temporaires
const MOUNTS = /^\/tmp\/\.mount_(proc-w|comput)/;
const mountsNow = () => readFileSync('/proc/self/mountinfo', 'utf8').split('\n').map((l) => l.split(' ')[4]).filter((m) => m && MOUNTS.test(m));
const preMounts = new Set(mountsNow());
console.log('montages de l’app déjà présents avant le test :', preMounts.size);
const base = mkdtempSync(join(homedir(), '.cache', 'pw-rename-e2e-'));
const home = join(base, 'home');
const cfg = join(base, 'cfg');
const data = join(base, 'data');
const cacheHome = join(base, 'cache');
const runtime = join(base, 'run');
mkdirSync(join(home, 'Applications'), { recursive: true });
mkdirSync(runtime, { mode: 0o700 });
const oldCopy = join(home, 'Applications/proc-watch.AppImage');
const newCopy = join(home, 'Applications/computer-watcher.AppImage');
const realRun = process.env.XDG_RUNTIME_DIR;
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: cfg,
  XDG_DATA_HOME: data,
  XDG_CACHE_HOME: cacheHome,
  XDG_RUNTIME_DIR: runtime,
  PROC_WATCH_NO_RECORDER_SYNC: '1',
  PROC_WATCH_NO_KILL: '1',
};
// affichage : le socket Wayland reste celui de la session (chemin absolu), le reste du dossier d'exécution est temporaire
if (realRun && process.env.WAYLAND_DISPLAY && !process.env.WAYLAND_DISPLAY.startsWith('/')) env.WAYLAND_DISPLAY = join(realRun, process.env.WAYLAND_DISPLAY);
for (const k of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'PROC_WATCH_UPDATE_FEED', 'ELECTRON_RUN_AS_NODE', 'PROC_WATCH_RELAUNCH', 'APPIMAGE_SILENT_INSTALL']) delete env[k];

/** Nos processus seulement : HOME temporaire dans l'environnement, leurs descendants, et ceux d'un montage apparu pendant le test. */
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
      const comm = (() => { try { return readFileSync(`/proc/${e}/comm`, 'utf8').trim(); } catch { return ''; } })();
      all.push({ pid: Number(e), ppid, mine, comm, exe: (() => { try { return readlinkSync(`/proc/${e}/exe`); } catch { return cmd || '?'; } })() });
    } catch {}
  }
  const set = new Set(all.filter((p) => p.mine).map((p) => p.pid));
  const byPid = new Map(all.map((p) => [p.pid, p]));
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of all) if (!set.has(p.pid) && set.has(p.ppid)) { set.add(p.pid); changed = true; }
    for (const pid of [...set]) {
      const parent = byPid.get(byPid.get(pid)?.ppid);
      if (parent && !set.has(parent.pid) && MOUNTS.test(parent.exe)) { set.add(parent.pid); changed = true; }
    }
  }
  for (const p of all) {
    const m = /^(\/tmp\/\.mount_[^/]+)\//.exec(p.exe);
    if (m && MOUNTS.test(m[1]) && !preMounts.has(m[1])) set.add(p.pid);
  }
  return all.filter((p) => set.has(p.pid) && p.pid !== process.pid).map(({ pid, exe, comm }) => ({ pid, exe, comm }));
}
async function killOurs() {
  for (let i = 0; i < 50; i++) {
    const ps = ours();
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
const stubDialogs = (app) => app.evaluate(({ dialog }) => {
  dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); // le test consent à la place de l'utilisateur
});
const exited = (app) => new Promise((r) => app.process().once('exit', r));
const shot = async (win, name) => shots && win.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

const L = { cfg: join(cfg, 'proc-watch'), data: join(data, 'proc-watch'), menu: join(data, 'applications/proc-watch.desktop'), auto: join(cfg, 'autostart/proc-watch.desktop'), icon: join(data, 'icons/hicolor/512x512/apps/proc-watch.png'), cache: join(cacheHome, 'proc-watch-updater') };
/** Dossier d'exécution à l'ancien nom : éphémère, jamais déplacé ni retiré par l'app (la nouvelle version recrée le sien). */
const legacyRun = join(runtime, 'proc-watch');
const N = { cfg: join(cfg, 'computer-watcher'), data: join(data, 'computer-watcher'), menu: join(data, 'applications/computer-watcher.desktop'), auto: join(cfg, 'autostart/computer-watcher.desktop'), icon: join(data, 'icons/hicolor/512x512/apps/computer-watcher.png'), cache: join(cacheHome, 'computer-watcher-updater') };
const ROWS = [1, 2, 3].map((i) => ({ ts: Date.now() - i * 60_000, detail: `{"e2e":"rename-${i}"}` }));

try {
  // ---------------------------------------------------------------- A. v0.1.3 installée comme une app
  copyFileSync(V013, oldCopy);
  chmodSync(oldCopy, 0o755);
  {
    const { app, win } = await launch(oldCopy);
    await win.locator('[data-testid="onboarding"]').waitFor({ timeout: 30000 });
    const r = await win.evaluate(async () => {
      const install = await window.procWatch.onboarding.install();
      const auto = await window.procWatch.autostart.set(true);
      const c = await window.procWatch.getConfig();
      await window.procWatch.setConfig({ ...c.config, recorder: { ...c.config.recorder, tmpfsAlertMB: 1234 } });
      await window.procWatch.onboarding.finish();
      return { install: install.status, auto: auto.enabled, version: (await window.procWatch.about.info()).version };
    });
    ok(r.version === '0.1.3', `A. v${r.version} lancée depuis ${oldCopy.slice(base.length)}`);
    ok(r.install === 'already' && r.auto, `A. installée comme une app (${r.install}), démarrage avec la session activé`);
    ok(readFileSync(L.menu, 'utf8').includes(`Exec="${oldCopy}"`) && readFileSync(L.menu, 'utf8').includes('X-ProcWatch-Managed=1'), 'A. menu proc-watch.desktop vers l’ancienne copie, marqué');
    ok(readFileSync(L.auto, 'utf8').includes(`Exec="${oldCopy}" --hidden`), 'A. démarrage automatique proc-watch.desktop --hidden');
    ok(existsSync(L.icon), 'A. icône proc-watch.png');
    await shot(win, 'a-v013');
    await killOurs();
  }
  ok(JSON.parse(readFileSync(join(L.cfg, 'config.json'), 'utf8')).recorder.tmpfsAlertMB === 1234, 'A. réglage modifié (seuil /tmp 1234 Mo) dans l’ancien dossier de config');
  // historique : la base v5 créée par le service de la v0.1.3 lui-même, puis 3 lignes connues
  {
    const rec = spawn(oldCopy, ['-e', "require(process.env.APPDIR + '/resources/app.asar/out/main/recorder.js')"], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' });
    const created = await waitFor(() => existsSync(join(L.data, 'recorder-status.json')), 30000);
    ok(created, 'A. service de la v0.1.3 : base d’historique créée');
    await killOurs();
    await new Promise((r) => (rec.exitCode !== null || rec.signalCode !== null ? r() : rec.once('exit', r)));
    const db = new DatabaseSync(join(L.data, 'metrics.db'));
    ok(db.prepare('PRAGMA user_version').get().user_version === 5, 'A. base au schéma v5');
    for (const row of ROWS) db.prepare("INSERT INTO events (ts, type, detail) VALUES (?, 'gap', ?)").run(row.ts, row.detail);
    db.close();
  }

  // ---------------------------------------------------------------- B. mise à jour v0.1.3 → 0.2.0 (flux à jeton)
  {
    const { app, win } = await launch(oldCopy);
    ok((await win.locator('[data-testid="onboarding"]').count()) === 0, 'B. v0.1.3 : accueil fait');
    const v = await win.evaluate(() => window.procWatch.update.check());
    ok(v.state.mode === 'install' && v.state.available?.version === '0.2.0', `B. 0.2.0 proposée (mode ${v.state.mode}, phase ${v.state.phase})`);
    await win.evaluate(() => window.procWatch.update.download());
    const ready = await waitFor(async () => (await win.evaluate(() => window.procWatch.update.get())).state.phase === 'ready', 180000, 500);
    ok(ready, 'B. 0.2.0 téléchargée et vérifiée (sha512)');
    const gone = exited(app);
    await win.evaluate(() => window.procWatch.update.install()).catch(() => {});
    await Promise.race([gone, sleep(30000)]);
    ok(true, 'B. v0.1.3 quittée pour installer');
  }

  // ---------------------------------------------------------------- C. migration par la 0.2.0
  {
    const moved = await waitFor(() => existsSync(newCopy) && !existsSync(oldCopy), 120000, 500);
    ok(moved, 'C. computer-watcher.AppImage en place, ancienne copie proc-watch.AppImage supprimée');
    if (!moved) {
      // diagnostic : état de la migration et ce qui tourne
      for (const f of [join(L.cfg, 'migration.json'), join(N.cfg, 'migration.json')]) if (existsSync(f)) console.log(`diagnostic ${f.slice(base.length)} :`, readFileSync(f, 'utf8'));
      for (const d of [cfg, data, join(home, 'Applications')]) console.log(`diagnostic ${d.slice(base.length)} :`, readdirSync(d).join(' '));
      console.log('diagnostic processus :', JSON.stringify(ours()));
    }
    ok(existsSync(newCopy) && sha(newCopy) === sha(V020), 'C. la nouvelle copie est la 0.2.0, identique');
    ok(existsSync(newCopy) && (statSync(newCopy).mode & 0o777) === 0o755, 'C. nouvelle copie en 0755');
    let p = null;
    await waitFor(() => (p = ours().find((x) => x.exe === newCopy)), 30000);
    ok(!!p, 'C. la 0.2.0 tourne depuis ~/Applications/computer-watcher.AppImage');
    const app = ours().find((x) => /^\/tmp\/\.mount_comput[^/]+\/computer-watcher$/.test(x.exe));
    ok(!!app && app.comm === 'computer-watche', `C. processus de l’app : comm « ${app?.comm} » (computer-watcher tronqué à 15 caractères)`);
    const rtEnv = p ? readFileSync(`/proc/${p.pid}/environ`, 'utf8') : '';
    ok(!!p && !rtEnv.includes('/tmp/.mount_'), 'C. environnement de la copie relancée : aucune entrée sous /tmp/.mount_');
    const state = await waitFor(() => existsSync(join(N.cfg, 'migration.json')), 30000) && JSON.parse(readFileSync(join(N.cfg, 'migration.json'), 'utf8'));
    ok(!!state && ['stop-legacy-service', 'move-dirs', 'new-service', 'desktop', 'appimage'].every((s) => state.done.includes(s) || state.skipped?.[s]) && !Object.keys(state.errors).length,
      `C. migration.json complet (${JSON.stringify(state)})`);
    ok(!!state && /PROC_WATCH_NO_RECORDER_SYNC/.test(state.skipped?.['stop-legacy-service'] ?? ''), 'C. service ignoré sous PROC_WATCH_NO_RECORDER_SYNC (et dit)');
    ok(JSON.parse(readFileSync(join(N.cfg, 'config.json'), 'utf8')).recorder.tmpfsAlertMB === 1234, 'C. réglages intacts dans ~/.config/computer-watcher');
    const db = new DatabaseSync(join(N.data, 'metrics.db'), { readOnly: true });
    const rows = db.prepare("SELECT ts, detail FROM events WHERE detail LIKE '%rename-%' ORDER BY detail").all().map((r) => ({ ts: r.ts, detail: r.detail }));
    db.close();
    ok(JSON.stringify(rows) === JSON.stringify([...ROWS].sort((a, b) => a.detail.localeCompare(b.detail))), 'C. historique intact dans ~/.local/share/computer-watcher (3 lignes connues)');
    for (const [k, path] of Object.entries(L)) ok(!existsSync(path), `C. ancien absent : ${k} (${path.slice(base.length)})`);
    ok(!existsSync(join(runtime, 'computer-watcher')) || !existsSync(legacyRun) || readdirSync(legacyRun).every((f) => f.startsWith('focus-')), 'C. dossier d’exécution jamais déplacé (seulement des fichiers de focus éphémères)');
    ok(readFileSync(N.menu, 'utf8').includes(`Exec="${newCopy}"`) && readFileSync(N.menu, 'utf8').includes('Name=Computer Watcher'), 'C. menu computer-watcher.desktop « Computer Watcher » vers la nouvelle copie');
    ok(readFileSync(N.auto, 'utf8').includes(`Exec="${newCopy}" --hidden`), 'C. démarrage automatique computer-watcher.desktop --hidden vers la nouvelle copie');
    ok(existsSync(N.icon), 'C. icône computer-watcher.png');
    ok(existsSync(N.cache), 'C. cache de l’updater déplacé (computer-watcher-updater)');
    const ob = JSON.parse(readFileSync(join(N.cfg, 'onboarding.json'), 'utf8'));
    ok(ob.done === true && !('deleteOriginal' in ob), `C. accord de suppression consommé, accueil toujours fait (${JSON.stringify(ob)})`);
    await killOurs();
    ok(ours().length === 0, 'C. instance arrêtée (par PID)');
  }

  // ---------------------------------------------------------------- D. relance, À propos, désinstallation
  {
    const { app, win } = await launch(newCopy);
    await win.waitForSelector('[data-testid="snapshot-ready"]', { timeout: 30000 }).catch(() => {});
    ok((await win.title()) === 'Computer Watcher', `D. titre de la fenêtre « ${await win.title()} »`);
    const about = await win.evaluate(() => window.procWatch.about.info());
    ok(about.version === '0.2.0' && about.installedCopy === newCopy && about.appImage === newCopy, `D. À propos : ${about.version}, copie ${about.installedCopy?.slice(base.length)}`);
    ok(about.migration?.status === 'done', `D. À propos : migration « ${about.migration?.status} »`);
    ok((await win.locator('[data-testid="onboarding"]').count()) === 0, 'D. pas d’assistant d’accueil');
    await shot(win, 'd-v020');
    await stubDialogs(app);
    const gone = exited(app);
    const r = await win.evaluate(() => window.procWatch.uninstall.run({ history: true, config: true }));
    console.log('désinstallation :', JSON.stringify(r.result));
    ok(r.result.done && r.result.failed.length === 0, 'D. désinstallation complète');
    ok(await Promise.race([gone.then(() => true), sleep(15000).then(() => false)]), 'D. l’app quitte');
    await sleep(2000);
    for (const [k, path] of [...Object.entries(N), ['copie', newCopy]]) ok(!existsSync(path), `D. retiré : ${k} (${path.slice(base.length)})`);
    for (const [k, path] of Object.entries(L)) ok(!existsSync(path), `D. aucun reste à l’ancien nom : ${k}`);
    await killOurs();
  }
} catch (e) {
  failures++;
  console.error('ERREUR', e);
} finally {
  await killOurs();
  server.close();
  console.log('requêtes au flux :', [...new Set(hits.map((h) => h.replace(meta.token, '<jeton>')))].join(' '));
  const left = ours();
  const newMounts = mountsNow().filter((m) => !preMounts.has(m));
  rmSync(base, { recursive: true, force: true });
  if (!keepBuild) rmSync(build, { recursive: true, force: true });
  ok(left.length === 0, `fin : aucun processus restant (${left.length})`);
  ok(newMounts.length === 0, `fin : aucun montage restant (${newMounts.join(' ')})`);
  console.log('nettoyé :', !existsSync(base), keepBuild ? `| construction gardée : ${build}` : '| construction supprimée');
  console.log(failures ? `ÉCHECS : ${failures}` : 'APPIMAGE RENAME E2E OK');
  process.exit(failures ? 1 : 0);
}
