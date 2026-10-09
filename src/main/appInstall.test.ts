import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import {
  appPaths, autostartState, installAppImage, verifyAndDeleteOriginal, launchTarget, rootsFrom, runUninstall, setAutostart, stopRecorderForUninstall,
  configSweepPlan, postExitSweepCommand, uninstallPlan, uninstallSummary, type Roots,
} from './appInstall';

// Racines temporaires sous ~/.cache/pw-onboard-* (jamais les vrais dossiers de l'utilisateur), retirées à la fin.
const cache = join(homedir(), '.cache');
mkdirSync(cache, { recursive: true });
const base = mkdtempSync(join(cache, 'pw-onboard-test-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
let roots: Roots;
let dl: string;
beforeEach(() => {
  const home = join(base, `h${++n}`);
  mkdirSync(home, { recursive: true });
  roots = rootsFrom({}, home);
  dl = join(home, 'Téléchargements');
  mkdirSync(dl, { recursive: true });
});

/** En-tête d'AppImage type 2 (ELF + « AI\x02 » à l'octet 8), suivi d'un corps. */
const AI = (body: string) => Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 0x02]), Buffer.from(body)]);
const fakeAppImage = (name = 'proc-watch-1.0.0-x86_64.AppImage', body: string | Buffer = AI('appimage-v1')) => {
  const p = join(dl, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
};

describe('chemins', () => {
  test('dérivés de HOME et des XDG injectés', () => {
    const r = rootsFrom({ XDG_CONFIG_HOME: '/c', XDG_DATA_HOME: '/d' }, '/home/u');
    const p = appPaths(r);
    expect(p.appImage).toBe('/home/u/Applications/proc-watch.AppImage');
    expect(p.autostart).toBe('/c/autostart/proc-watch.desktop');
    expect(p.desktop).toBe('/d/applications/proc-watch.desktop');
    expect(p.icon).toBe('/d/icons/hicolor/512x512/apps/proc-watch.png');
    expect(p.unit).toBe('/c/systemd/user/proc-watch-recorder.service');
    expect(p.configDir).toBe('/c/proc-watch');
    expect(p.dataDir).toBe('/d/proc-watch');
    expect(appPaths(rootsFrom({}, '/home/u')).autostart).toBe('/home/u/.config/autostart/proc-watch.desktop');
    expect(appPaths(rootsFrom({ XDG_CACHE_HOME: '/k' }, '/home/u')).updaterCache).toBe('/k/proc-watch-updater');
    expect(appPaths(rootsFrom({}, '/home/u')).updaterCache).toBe('/home/u/.cache/proc-watch-updater');
  });
});

describe('installer l’AppImage', () => {
  test('copie 0755 dans ~/Applications, entrée de menu vers la copie, aucun fichier temporaire', async () => {
    const src = fakeAppImage();
    const r = await installAppImage({ source: src, roots });
    const p = appPaths(roots);
    expect(r).toMatchObject({ status: 'installed', dest: p.appImage, runningFromCopy: false, canDeleteSource: true });
    expect(readFileSync(p.appImage)).toEqual(AI('appimage-v1'));
    expect(statSync(p.appImage).mode & 0o777).toBe(0o755);
    expect(readFileSync(p.desktop, 'utf8')).toContain(`Exec="${p.appImage}"`);
    expect(readdirSync(join(roots.home, 'Applications'))).toEqual(['proc-watch.AppImage']);
    expect(existsSync(src)).toBe(true); // l'original n'est jamais touché sans accord
  });

  test('idempotent : déjà installée (même contenu) → rien recopié', async () => {
    const src = fakeAppImage();
    await installAppImage({ source: src, roots });
    const before = statSync(appPaths(roots).appImage).ino;
    const r = await installAppImage({ source: src, roots });
    expect(r.status).toBe('already');
    expect(statSync(appPaths(roots).appImage).ino).toBe(before);
  });

  test('lancée depuis la copie : déjà installée, rien à supprimer', async () => {
    const src = fakeAppImage();
    const first = await installAppImage({ source: src, roots });
    const r = await installAppImage({ source: first.dest, roots });
    expect(r).toMatchObject({ status: 'already', runningFromCopy: true, canDeleteSource: false });
  });

  test('autre version : remplacée (mise à jour)', async () => {
    await installAppImage({ source: fakeAppImage('a.AppImage', AI('v1')), roots });
    const r = await installAppImage({ source: fakeAppImage('b.AppImage', AI('v2')), roots });
    expect(r.status).toBe('updated');
    expect(readFileSync(r.dest)).toEqual(AI('v2'));
  });

  test('lien symbolique planté à la place de la copie : remplacé, sa cible intacte', async () => {
    const victim = join(roots.home, 'victim');
    writeFileSync(victim, 'précieux');
    mkdirSync(join(roots.home, 'Applications'));
    symlinkSync(victim, appPaths(roots).appImage);
    await installAppImage({ source: fakeAppImage(), roots });
    expect(readFileSync(victim, 'utf8')).toBe('précieux');
    expect(lstatSync(appPaths(roots).appImage).isSymbolicLink()).toBe(false);
  });

  test('démarrage automatique déjà actif : repointé vers la copie', async () => {
    const src = fakeAppImage();
    setAutostart(true, src, roots);
    const r = await installAppImage({ source: src, roots });
    expect(r.autostartUpdated).toBe(true);
    expect(readFileSync(appPaths(roots).autostart, 'utf8')).toContain(`Exec="${r.dest}" --hidden`);
  });

  test('copie : SHA-256 identique à l’original, exécutable', async () => {
    const r = await installAppImage({ source: fakeAppImage(), roots });
    expect(r.sha256).toBe(createHash('sha256').update(AI('appimage-v1')).digest('hex'));
    expect(r.executable).toBe(true);
  });

  test('m3 : copie identique mais en 0644 → remise en 0755 (fchmod, sans suivre de lien)', async () => {
    const src = fakeAppImage();
    const r = await installAppImage({ source: src, roots });
    chmodSync(r.dest, 0o644);
    expect((await installAppImage({ source: src, roots })).status).toBe('already');
    expect(statSync(r.dest).mode & 0o777).toBe(0o755);
  });

  test('reproduction I1 [2] : entrée de menu et démarrage automatique étrangers (sans marque) : laissés, signalés', async () => {
    const p = appPaths(roots);
    mkdirSync(dirname(p.autostart), { recursive: true });
    writeFileSync(p.autostart, '[Desktop Entry]\nName=mine\nExec=/usr/bin/my-own --flag\n');
    mkdirSync(dirname(p.desktop), { recursive: true });
    writeFileSync(p.desktop, '[Desktop Entry]\nName=mine-menu\nExec=/usr/bin/my-own\n');
    const r = await installAppImage({ source: fakeAppImage(), roots });
    expect(readFileSync(p.autostart, 'utf8')).toContain('my-own');
    expect(readFileSync(p.desktop, 'utf8')).toContain('my-own');
    expect(r.desktopFile).toBeNull();
    expect(r.autostartUpdated).toBe(false);
    expect(r.warnings.join('\n')).toMatch(/applications\/proc-watch\.desktop.*pas été créé par proc-watch/);
    expect(r.warnings.join('\n')).toMatch(/autostart\/proc-watch\.desktop.*pas été créé par proc-watch/);
    expect(existsSync(p.appImage)).toBe(true); // la copie elle-même est faite
  });

  test('~/Applications remplacé par un lien : refusé, rien copié dans le dossier visé', async () => {
    const victimDir = join(roots.home, 'victim-dir');
    mkdirSync(victimDir);
    symlinkSync(victimDir, join(roots.home, 'Applications'));
    await expect(installAppImage({ source: fakeAppImage(), roots })).rejects.toThrow(/lien symbolique/);
    expect(readdirSync(victimDir)).toEqual([]);
  });

  test('source absente : erreur en français', async () => {
    await expect(installAppImage({ source: join(dl, 'nope.AppImage'), roots })).rejects.toThrow(/AppImage introuvable/);
  });
});

describe('supprimer le fichier téléchargé (accord par onboarding.json, vérifié dans la copie relancée)', () => {
  const sha = (t: string | Buffer) => createHash('sha256').update(t).digest('hex');
  const ino = (p: string) => statSync(p).ino;

  test('l’API par ligne de commande n’existe plus (anciens arguments ignorés)', async () => {
    const mod = await import('./appInstall');
    expect('parseDeleteOriginalArgs' in mod).toBe(false);
    expect('deleteOriginalArgs' in mod).toBe(false);
  });

  test('supprime exactement le fichier d’origine : identique à la copie en cours, en-tête AppImage, même inode', async () => {
    const src = fakeAppImage();
    const other = fakeAppImage('autre.AppImage', AI('x'));
    const r = await installAppImage({ source: src, roots });
    await verifyAndDeleteOriginal({ path: src, sha256: r.sha256, ino: ino(src), copy: r.dest });
    expect(existsSync(src)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(r.dest)).toBe(true);
  });
  test('reproduction R1 : un document avec son vrai SHA-256 → refusé (pas une AppImage, pas identique à la copie)', async () => {
    const r = await installAppImage({ source: fakeAppImage(), roots });
    const doc = join(roots.home, 'thesis.pdf');
    writeFileSync(doc, 'MY THESIS');
    await expect(verifyAndDeleteOriginal({ path: doc, sha256: sha('MY THESIS'), ino: ino(doc), copy: r.dest })).rejects.toThrow(/pas une AppImage/);
    expect(existsSync(doc)).toBe(true);
  });
  test('reproduction R1 bis : une autre AppImage avec son vrai SHA-256 → refusée (différente de la copie en cours)', async () => {
    const r = await installAppImage({ source: fakeAppImage(), roots });
    const otherApp = fakeAppImage('Editeur-1.2.3.AppImage', AI('autre application'));
    await expect(verifyAndDeleteOriginal({ path: otherApp, sha256: sha(AI('autre application')), ino: ino(otherApp), copy: r.dest })).rejects.toThrow(/copie en cours/);
    expect(existsSync(otherApp)).toBe(true);
  });
  test('f1 : même fichier que la copie sous un autre chemin (lien physique, second montage) → refusé (dev+ino), copie intacte', async () => {
    const r = await installAppImage({ source: fakeAppImage(), roots });
    const alias = join(dl, 'alias.AppImage');
    linkSync(r.dest, alias);
    await expect(verifyAndDeleteOriginal({ path: alias, sha256: r.sha256, ino: ino(alias), copy: r.dest })).rejects.toThrow(/copie installée/);
    expect(existsSync(alias)).toBe(true);
    expect(existsSync(r.dest)).toBe(true);
  });
  test('refuse la copie elle-même', async () => {
    const r = await installAppImage({ source: fakeAppImage(), roots });
    await expect(verifyAndDeleteOriginal({ path: r.dest, sha256: r.sha256, ino: ino(r.dest), copy: r.dest })).rejects.toThrow(/copie installée/);
    expect(existsSync(r.dest)).toBe(true);
  });
  test('refuse un fichier modifié depuis l’accord, ou remplacé (autre inode)', async () => {
    const src = fakeAppImage();
    const r = await installAppImage({ source: src, roots });
    const i = ino(src);
    writeFileSync(src, AI('modifié'));
    await expect(verifyAndDeleteOriginal({ path: src, sha256: r.sha256, ino: i, copy: r.dest })).rejects.toThrow();
    expect(existsSync(src)).toBe(true);
    const src2 = fakeAppImage('p2.AppImage');
    await expect(verifyAndDeleteOriginal({ path: src2, sha256: r.sha256, ino: i + 999_999, copy: r.dest })).rejects.toThrow(/remplacé/);
    expect(existsSync(src2)).toBe(true);
  });
  test('refuse un lien symbolique (jamais suivi) et un chemin relatif', async () => {
    const real = fakeAppImage();
    const r = await installAppImage({ source: real, roots });
    const link = join(dl, 'lien.AppImage');
    symlinkSync(real, link);
    await expect(verifyAndDeleteOriginal({ path: link, sha256: r.sha256, ino: ino(real), copy: r.dest })).rejects.toThrow(/lien symbolique/);
    expect(existsSync(real)).toBe(true);
    await expect(verifyAndDeleteOriginal({ path: 'x.AppImage', sha256: r.sha256, ino: 1, copy: r.dest })).rejects.toThrow();
  });
});

describe('démarrer avec la session', () => {
  test('cible : copie installée, sinon AppImage lancée, sinon binaire empaqueté, sinon indisponible (dev)', async () => {
    const src = fakeAppImage();
    expect(launchTarget({ roots, appImage: src, packaged: true, execPath: '/tmp/.mount/proc-watch' })).toBe(src);
    await installAppImage({ source: src, roots });
    expect(launchTarget({ roots, appImage: src, packaged: true, execPath: '/x' })).toBe(appPaths(roots).appImage);
    expect(launchTarget({ roots, packaged: true, execPath: '/opt/proc-watch/proc-watch' })).toBe('/opt/proc-watch/proc-watch');
    expect(launchTarget({ roots, packaged: false, execPath: '/node_modules/electron/dist/electron' })).toBeNull();
  });
  test('R2 : copie vide (laissée par une mise à jour ratée) ou sans en-tête AppImage → l’AppImage lancée', async () => {
    const src = fakeAppImage();
    mkdirSync(join(roots.home, 'Applications'), { recursive: true });
    writeFileSync(appPaths(roots).appImage, '');
    expect(launchTarget({ roots, appImage: src, packaged: true, execPath: '/x' })).toBe(src);
    writeFileSync(appPaths(roots).appImage, 'pas une AppImage');
    expect(launchTarget({ roots, appImage: src, packaged: true, execPath: '/x' })).toBe(src);
  });
  test('activer : ~/.config/autostart/proc-watch.desktop avec --hidden ; désactiver : retiré ; deux fois : idempotent', () => {
    setAutostart(true, '/home/u/Applications/proc-watch.AppImage', roots);
    setAutostart(true, '/home/u/Applications/proc-watch.AppImage', roots);
    const p = appPaths(roots).autostart;
    expect(readFileSync(p, 'utf8')).toContain('Exec="/home/u/Applications/proc-watch.AppImage" --hidden\n');
    expect(autostartState(roots)).toEqual({ enabled: true, path: p });
    setAutostart(false, null, roots);
    setAutostart(false, null, roots);
    expect(existsSync(p)).toBe(false);
    expect(autostartState(roots).enabled).toBe(false);
  });
  test('activer sans cible (dev) : erreur', () => {
    expect(() => setAutostart(true, null, roots)).toThrow(/version installée/);
  });
  test('reproduction I1 [2b] : activer par-dessus un démarrage automatique étranger → refusé, laissé', () => {
    const p = appPaths(roots).autostart;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, '[Desktop Entry]\nName=mine\nExec=/usr/bin/my-own\n');
    expect(() => setAutostart(true, '/x/proc-watch.AppImage', roots)).toThrow(/pas été créé par proc-watch/);
    expect(readFileSync(p, 'utf8')).toContain('my-own');
  });
  test('reproduction I1 [3] : ~/.config/autostart remplacé par un lien → refusé, fichier du dossier visé intact', () => {
    const victimDir = join(roots.home, 'victim-dir');
    mkdirSync(victimDir);
    writeFileSync(join(victimDir, 'proc-watch.desktop'), 'FOREIGN in victim dir\n');
    mkdirSync(roots.configHome, { recursive: true });
    symlinkSync(victimDir, join(roots.configHome, 'autostart'));
    expect(() => setAutostart(true, '/x/proc-watch.AppImage', roots)).toThrow(/lien symbolique/);
    expect(readFileSync(join(victimDir, 'proc-watch.desktop'), 'utf8')).toBe('FOREIGN in victim dir\n');
  });
  test('désactiver : un fichier sans X-ProcWatch-Managed=1 (pas créé par proc-watch) reste', () => {
    mkdirSync(join(roots.configHome, 'autostart'), { recursive: true });
    writeFileSync(appPaths(roots).autostart, '[Desktop Entry]\nExec=autre\n');
    expect(() => setAutostart(false, null, roots)).toThrow(/pas été créé par proc-watch/);
    expect(existsSync(appPaths(roots).autostart)).toBe(true);
  });
  test('désactiver avec un lien symbolique planté : refusé, cible intacte', () => {
    const victim = join(roots.home, 'victim');
    writeFileSync(victim, 'précieux');
    mkdirSync(join(roots.configHome, 'autostart'), { recursive: true });
    symlinkSync(victim, appPaths(roots).autostart);
    expect(() => setAutostart(false, null, roots)).toThrow(/lien symbolique/);
    expect(readFileSync(victim, 'utf8')).toBe('précieux');
  });
});

/** Installation complète dans les racines de test : copie, menu, icône, démarrage auto, unité, historique, config. */
async function fullInstall() {
  const p = appPaths(roots);
  const icon = join(roots.home, 'icon.png');
  writeFileSync(icon, 'png');
  await installAppImage({ source: fakeAppImage(), roots, iconPng: icon });
  setAutostart(true, p.appImage, roots);
  mkdirSync(join(roots.configHome, 'systemd/user'), { recursive: true });
  writeFileSync(p.unit, '[Unit]\n');
  mkdirSync(p.dataDir, { recursive: true });
  for (const f of ['metrics.db', 'metrics.db-wal', 'metrics.db.pre-v4-20260101T000000', 'recorder-status.json', 'app-events.jsonl']) writeFileSync(join(p.dataDir, f), 'x');
  mkdirSync(p.configDir, { recursive: true });
  for (const f of ['config.json', 'config.json.bak', 'onboarding.json']) writeFileSync(join(p.configDir, f), '{}');
  return p;
}

const okService = () => ({ stop: async () => null, reload: async () => {} });

describe('désinstaller', () => {
  test('plan : liste exacte, dans l’ordre, AppImage en dernier ; historique et config seulement si cochés', async () => {
    const p = await fullInstall();
    const bare = uninstallPlan(roots, { history: false, config: false });
    expect(bare.map((i) => i.path)).toEqual([p.autostart, p.desktop, p.icon, p.unit, p.appImage]);
    const all = uninstallPlan(roots, { history: true, config: true });
    expect(all.map((i) => i.kind)).toEqual([
      'autostart', 'desktop', 'icon', 'service',
      'history', 'history', 'history', 'history', 'history', 'history',
      'config', 'config', 'config', 'config',
      'appimage',
    ]);
    expect(all.at(-1)!.path).toBe(p.appImage);
    expect(all.filter((i) => i.dir).map((i) => i.path)).toEqual([p.dataDir, p.configDir]);
  });

  test('configuration : fichiers des mises à jour et profil Chromium de l’app (noms connus) retirés, dossier retiré ; inconnus gardés', async () => {
    const p = await fullInstall();
    writeFileSync(join(p.configDir, 'updater.json'), '{}');
    writeFileSync(join(p.configDir, '.updaterId'), 'id');
    mkdirSync(join(p.configDir, 'GPUCache/sub'), { recursive: true });
    writeFileSync(join(p.configDir, 'GPUCache/sub/data_0'), 'x');
    mkdirSync(join(p.configDir, 'Local Storage/leveldb'), { recursive: true });
    writeFileSync(join(p.configDir, 'Preferences'), '{}');
    symlinkSync('host-123', join(p.configDir, 'SingletonLock'));
    const plan = uninstallPlan(roots, { history: false, config: true });
    for (const n of ['updater.json', '.updaterId', 'GPUCache', 'Local Storage', 'Preferences', 'SingletonLock']) expect(plan.map((i) => i.path)).toContain(join(p.configDir, n));
    const r = await runUninstall(plan, roots, { service: okService() });
    expect(r.failed).toEqual([]);
    expect(existsSync(p.configDir)).toBe(false);
  });

  test('fichiers inconnus des dossiers de données et de config : jamais listés, dossier laissé', async () => {
    const p = await fullInstall();
    writeFileSync(join(p.dataDir, 'notes-perso.txt'), 'à moi');
    writeFileSync(join(p.configDir, 'autre.json'), '{}');
    const plan = uninstallPlan(roots, { history: true, config: true });
    expect(plan.map((i) => i.path)).not.toContain(join(p.dataDir, 'notes-perso.txt'));
    const r = await runUninstall(plan, roots, { service: okService() });
    expect(readFileSync(join(p.dataDir, 'notes-perso.txt'), 'utf8')).toBe('à moi');
    expect(existsSync(join(p.configDir, 'autre.json'))).toBe(true);
    expect(r.kept.map((k) => k.path)).toEqual(expect.arrayContaining([p.dataDir, p.configDir]));
    expect(r.failed).toEqual([]);
    expect(r.done).toBe(true);
  });

  test('tout retirer : chaque fichier, puis les dossiers vides, puis l’AppImage ; earlyoom jamais dans le plan', async () => {
    const p = await fullInstall();
    const order: string[] = [];
    const plan = uninstallPlan(roots, { history: true, config: true });
    expect(JSON.stringify(plan)).not.toMatch(/earlyoom/);
    const r = await runUninstall(plan, roots, {
      service: { stop: async (u) => (order.push(`stop:${u}`), null), reload: async () => void order.push('reload') },
      beforeHistory: () => order.push('close-db'),
      onRemoved: (path) => order.push(path),
    });
    expect(r.failed).toEqual([]);
    expect(r.done).toBe(true);
    for (const x of [p.autostart, p.desktop, p.icon, p.unit, p.dataDir, p.configDir, p.appImage]) expect(existsSync(x)).toBe(false);
    expect(order.indexOf(`stop:${p.unit}`)).toBeLessThan(order.indexOf(p.unit));
    expect(order.indexOf('reload')).toBeGreaterThan(order.indexOf(p.unit));
    expect(order.indexOf('close-db')).toBeLessThan(order.indexOf(join(p.dataDir, 'metrics.db')));
    expect(order.at(-1)).toBe(p.appImage);
    expect(existsSync(join(roots.home, 'Applications'))).toBe(true); // le dossier ~/Applications n'est pas à proc-watch
  });

  test('lien symbolique planté à un chemin de la liste : jamais suivi, cible intacte, échec signalé, AppImage gardée', async () => {
    const p = await fullInstall();
    const victim = join(roots.home, 'victim.txt');
    writeFileSync(victim, 'précieux');
    rmSync(p.desktop);
    symlinkSync(victim, p.desktop);
    const victimDir = join(roots.home, 'victim-dir');
    mkdirSync(victimDir);
    writeFileSync(join(victimDir, 'metrics.db'), 'précieux');
    rmSync(p.dataDir, { recursive: true });
    symlinkSync(victimDir, p.dataDir);
    const plan = uninstallPlan(roots, { history: true, config: false });
    const r = await runUninstall(plan, roots, { service: okService() });
    expect(readFileSync(victim, 'utf8')).toBe('précieux');
    expect(readFileSync(join(victimDir, 'metrics.db'), 'utf8')).toBe('précieux');
    expect(lstatSync(p.desktop).isSymbolicLink()).toBe(true);
    expect(r.failed.map((f) => f.path)).toContain(p.desktop);
    expect(r.failed.find((f) => f.path === p.desktop)!.error).toMatch(/lien symbolique/);
    expect(existsSync(p.appImage)).toBe(true);
    expect(r.kept.map((k) => k.path)).toContain(p.appImage);
    expect(r.done).toBe(false);
  });

  test('élément hors de la liste autorisée (chemin injecté) : refusé, rien supprimé', async () => {
    const p = await fullInstall();
    const victim = join(roots.home, 'victim.txt');
    writeFileSync(victim, 'précieux');
    const plan = [...uninstallPlan(roots, { history: false, config: false })];
    plan.splice(0, 0, { kind: 'desktop', path: victim, label: 'x' });
    plan.splice(1, 0, { kind: 'history', path: join(p.dataDir, '..', 'proc-watch', '..', 'victim.txt'), label: 'x' });
    const r = await runUninstall(plan, roots, { service: okService() });
    expect(readFileSync(victim, 'utf8')).toBe('précieux');
    expect(r.failed.filter((f) => /hors de la liste/.test(f.error))).toHaveLength(2);
  });

  test('échecs partiels : service qui refuse de s’arrêter → signalé, unité et AppImage gardées, le reste retiré', async () => {
    const p = await fullInstall();
    const plan = uninstallPlan(roots, { history: false, config: false });
    const r = await runUninstall(plan, roots, { service: { stop: async () => 'systemctl disable --now a échoué', reload: async () => {} } });
    expect(r.failed).toEqual([{ path: p.unit, error: 'systemctl disable --now a échoué' }]);
    expect(existsSync(p.unit)).toBe(true);
    expect(existsSync(p.autostart)).toBe(false);
    expect(existsSync(p.appImage)).toBe(true);
    expect(r.done).toBe(false);
  });

  test('entrées .desktop sans X-ProcWatch-Managed=1 : jamais listées ni retirées', async () => {
    const p = await fullInstall();
    writeFileSync(p.desktop, '[Desktop Entry]\nName=proc-watch\nExec=/opt/x\n');
    const plan = uninstallPlan(roots, { history: false, config: false });
    expect(plan.map((i) => i.path)).not.toContain(p.desktop);
    plan.unshift({ kind: 'desktop', path: p.desktop, label: 'x' }); // plan forgé : revérifié à l'exécution
    const r = await runUninstall(plan, roots, { service: okService() });
    expect(existsSync(p.desktop)).toBe(true);
    expect(r.kept.map((k) => k.path)).toContain(p.desktop);
  });

  test('m2 : ~/Applications et dossier des icônes remplacés par des liens → rien supprimé dans les dossiers visés', async () => {
    const p = await fullInstall();
    const victimDir = join(roots.home, 'victim-apps');
    mkdirSync(victimDir);
    writeFileSync(join(victimDir, 'proc-watch.AppImage'), 'autre');
    writeFileSync(join(victimDir, 'proc-watch.png'), 'autre');
    rmSync(join(roots.home, 'Applications'), { recursive: true });
    symlinkSync(victimDir, join(roots.home, 'Applications'));
    rmSync(dirname(p.icon), { recursive: true });
    symlinkSync(victimDir, dirname(p.icon));
    const r = await runUninstall(uninstallPlan(roots, { history: false, config: false }), roots, { service: okService() });
    expect(readFileSync(join(victimDir, 'proc-watch.AppImage'), 'utf8')).toBe('autre');
    expect(readFileSync(join(victimDir, 'proc-watch.png'), 'utf8')).toBe('autre');
    expect(r.failed.map((f) => f.path)).toContain(p.icon);
    expect(r.done).toBe(false);
  });

  test('élément déjà absent au moment de la suppression : ni échec ni retiré', async () => {
    const p = await fullInstall();
    const plan = uninstallPlan(roots, { history: false, config: false });
    rmSync(p.icon);
    const r = await runUninstall(plan, roots, { service: okService() });
    expect(r.removed).not.toContain(p.icon);
    expect(r.failed).toEqual([]);
    expect(r.done).toBe(true);
  });

  test('résumé de la confirmation : chaque chemin, earlyoom non modifié, paquet .deb', async () => {
    const p = await fullInstall();
    const s = uninstallSummary(uninstallPlan(roots, { history: false, config: false }), { deb: false });
    for (const x of [p.autostart, p.desktop, p.icon, p.unit, p.appImage]) expect(s.detail).toContain(x);
    expect(s.detail).toMatch(/earlyoom n’est pas modifié/);
    expect(s.detail).toMatch(/Historique et configuration : gardés/);
    expect(uninstallSummary([], { deb: true }).detail).toMatch(/apt remove proc-watch/);
  });
});

describe('arrêt du service à la désinstallation (échoue fermé)', () => {
  const calls: string[][] = [];
  const run = (frag: string) => async (args: string[]) => {
    calls.push(args);
    return { ok: true, stdout: args[0] === 'show' ? `${frag}\n` : '' };
  };
  beforeEach(() => void (calls.length = 0));

  test('PROC_WATCH_NO_RECORDER_SYNC : aucun appel systemctl, unité laissée (et dit)', async () => {
    const r = await stopRecorderForUninstall({ unitPath: '/c/u.service', run: run('/c/u.service'), disabled: true });
    expect(r).toMatchObject({ stopped: false, error: null });
    expect(r.keep).toMatch(/PROC_WATCH_NO_RECORDER_SYNC/);
    expect(calls).toEqual([]);
  });
  test('reproduction I3 [5] : systemctl --user show en échec → erreur (rien retiré)', async () => {
    const failing = async (args: string[]) => (calls.push(args), { ok: false, stdout: '' });
    const r = await stopRecorderForUninstall({ unitPath: '/c/u.service', run: failing, disabled: false });
    expect(r.error).toMatch(/systemctl --user show a échoué/);
    expect(calls.map((c) => c[0])).toEqual(['show']);
  });
  test('unité chargée depuis un autre fichier : erreur, jamais arrêtée', async () => {
    const r = await stopRecorderForUninstall({ unitPath: '/tmp-cfg/u.service', run: run('/home/u/.config/systemd/user/u.service'), disabled: false });
    expect(r.error).toMatch(/chargé depuis \/home\/u\/.config/);
    expect(calls.map((c) => c[0])).toEqual(['show']);
  });
  test('unité non chargée et aucun lien d’activation : rien à arrêter', async () => {
    expect(await stopRecorderForUninstall({ unitPath: join(roots.configHome, 'systemd/user/proc-watch-recorder.service'), run: run(''), disabled: false })).toEqual({ stopped: false, error: null });
  });
  test('unité non chargée mais lien default.target.wants présent : erreur', async () => {
    const unit = join(roots.configHome, 'systemd/user/proc-watch-recorder.service');
    mkdirSync(join(dirname(unit), 'default.target.wants'), { recursive: true });
    symlinkSync(unit, join(dirname(unit), 'default.target.wants/proc-watch-recorder.service'));
    expect((await stopRecorderForUninstall({ unitPath: unit, run: run(''), disabled: false })).error).toMatch(/default\.target\.wants/);
  });
  test('notre unité : disable --now', async () => {
    expect(await stopRecorderForUninstall({ unitPath: '/c/u.service', run: run('/c/u.service'), disabled: false })).toEqual({ stopped: true, error: null });
    expect(calls[1]).toEqual(['disable', '--now', 'proc-watch-recorder.service']);
  });
  test('disable qui échoue : erreur signalée', async () => {
    const failing = async (args: string[]) => (args[0] === 'show' ? { ok: true, stdout: '/c/u.service' } : { ok: false, stdout: '' });
    expect((await stopRecorderForUninstall({ unitPath: '/c/u.service', run: failing, disabled: false })).error).toMatch(/échoué/);
  });

  test('reproduction I3 [5] de bout en bout : show en échec → unité ET AppImage gardées, échec rapporté', async () => {
    const p = await fullInstall();
    const plan = uninstallPlan(roots, { history: false, config: false });
    const failing = async () => ({ ok: false, stdout: '' });
    const r = await runUninstall(plan, roots, {
      service: { stop: async (u) => stopRecorderForUninstall({ unitPath: u, run: failing, disabled: false }), reload: async () => {} },
    });
    expect(existsSync(p.unit)).toBe(true);
    expect(existsSync(p.appImage)).toBe(true);
    expect(r.failed.map((f) => f.path)).toEqual([p.unit]);
    expect(r.done).toBe(false);
  });
  test('PROC_WATCH_NO_RECORDER_SYNC de bout en bout : unité jamais touchée, dit, AppImage gardée', async () => {
    const p = await fullInstall();
    const plan = uninstallPlan(roots, { history: false, config: false });
    const r = await runUninstall(plan, roots, {
      service: { stop: async (u) => stopRecorderForUninstall({ unitPath: u, run: async () => ({ ok: true, stdout: '' }), disabled: true }), reload: async () => {} },
    });
    expect(existsSync(p.unit)).toBe(true);
    expect(r.kept.find((k) => k.path === p.unit)!.reason).toMatch(/PROC_WATCH_NO_RECORDER_SYNC/);
    expect(existsSync(p.appImage)).toBe(true);
    expect(r.done).toBe(false);
  });

});

describe('cache de l’updater (proc-watch-updater) avec « Supprimer la configuration »', () => {
  test('listé et retiré seulement avec la configuration ; contenu retiré sans suivre de lien', async () => {
    const p = await fullInstall();
    mkdirSync(join(p.updaterCache, 'pending'), { recursive: true });
    writeFileSync(join(p.updaterCache, 'pending/proc-watch-0.1.1-x86_64.AppImage'), 'x');
    const victim = join(roots.home, 'victim');
    mkdirSync(victim);
    writeFileSync(join(victim, 'precious'), 'x');
    symlinkSync(victim, join(p.updaterCache, 'lien'));
    expect(uninstallPlan(roots, { history: false, config: false }).map((i) => i.path)).not.toContain(p.updaterCache);
    const plan = uninstallPlan(roots, { history: false, config: true });
    expect(plan.find((i) => i.path === p.updaterCache)).toMatchObject({ kind: 'cache', tree: true });
    const r = await runUninstall(plan, roots, { service: okService() });
    expect(r.failed).toEqual([]);
    expect(existsSync(p.updaterCache)).toBe(false);
    expect(existsSync(join(victim, 'precious'))).toBe(true);
  });
  test('cache remplacé par un lien symbolique : le lien seul est retiré, jamais sa cible', async () => {
    const p = await fullInstall();
    const victim = join(roots.home, 'victim-cache');
    mkdirSync(victim);
    writeFileSync(join(victim, 'precious'), 'x');
    mkdirSync(roots.cacheHome, { recursive: true });
    symlinkSync(victim, p.updaterCache);
    const r = await runUninstall(uninstallPlan(roots, { history: false, config: true }), roots, { service: okService() });
    expect(r.failed).toEqual([]);
    expect(lstatSync(p.updaterCache, { throwIfNoEntry: false })).toBeUndefined();
    expect(readFileSync(join(victim, 'precious'), 'utf8')).toBe('x');
  });
  test('chemin de cache forgé (autre nom sous le cache) : refusé', async () => {
    await fullInstall();
    const other = join(roots.cacheHome, 'autre-app');
    mkdirSync(other, { recursive: true });
    const r = await runUninstall([{ kind: 'cache', path: other, label: 'x', tree: true }], roots, { service: okService() });
    expect(existsSync(other)).toBe(true);
    expect(r.failed[0]!.error).toMatch(/hors de la liste/);
  });
});

describe('dernier passage sur la configuration (Chromium réécrit son profil en quittant)', () => {
  test('ne liste que la configuration (jamais historique, service, menu ni AppImage)', async () => {
    const p = await fullInstall();
    mkdirSync(join(p.configDir, 'Session Storage'), { recursive: true });
    const plan = configSweepPlan(roots);
    expect(plan.every((i) => i.kind === 'config')).toBe(true);
    expect(plan.map((i) => i.path)).toContain(join(p.configDir, 'Session Storage'));
    expect(plan.at(-1)!.path).toBe(p.configDir);
  });
});

describe('après la sortie : « Session Storage » recréé par Chromium en quittant (vu avec une vraie AppImage)', () => {
  const runSweep = (dir: string) => {
    const [cmd, args] = postExitSweepCommand(999_999_999, dir); // PID inexistant : pas d'attente
    execFileSync(cmd, args);
  };
  test('retire « Session Storage » puis le dossier de config vide', () => {
    const d = join(roots.configHome, 'proc-watch');
    mkdirSync(join(d, 'Session Storage'), { recursive: true });
    writeFileSync(join(d, 'Session Storage/000003.log'), 'x');
    runSweep(d);
    expect(existsSync(d)).toBe(false);
  });
  test('autre fichier présent : dossier gardé ; « Session Storage » en lien : jamais suivi ; dossier de config en lien : rien', () => {
    const d = join(roots.configHome, 'proc-watch');
    const victim = join(roots.home, 'victim');
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, 'precious'), 'x');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'autre'), 'x');
    symlinkSync(victim, join(d, 'Session Storage'));
    runSweep(d);
    expect(existsSync(join(victim, 'precious'))).toBe(true);
    expect(existsSync(join(d, 'autre'))).toBe(true);
    const linked = join(roots.configHome, 'lien');
    mkdirSync(join(victim, 'Session Storage'));
    symlinkSync(victim, linked);
    runSweep(linked);
    expect(existsSync(join(victim, 'Session Storage'))).toBe(true);
  });
  test('chemins passés en arguments, jamais dans le script', () => {
    const [, args] = postExitSweepCommand(42, '/c/proc-watch$(id)');
    expect(args[1]).not.toContain('proc-watch$(id)');
    expect(args.slice(-2)).toEqual(['42', '/c/proc-watch$(id)']);
  });
});
