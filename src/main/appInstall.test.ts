import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import {
  appPaths, autostartState, installAppImage, verifyAndDeleteOriginal, launchTarget, rootsFrom, runUninstall, setAutostart, stopRecorderForUninstall,
  configSweepPlan, postExitSweepCommand, sweepTools, uninstallPlan, uninstallSummary, type Roots,
} from './appInstall';
import { desktopEntryContent } from './desktopEntry';

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
    expect(p.appImage).toBe('/home/u/Applications/computer-watcher.AppImage');
    expect(p.autostart).toBe('/c/autostart/computer-watcher.desktop');
    expect(p.desktop).toBe('/d/applications/computer-watcher.desktop');
    expect(p.icon).toBe('/d/icons/hicolor/512x512/apps/computer-watcher.png');
    expect(p.unit).toBe('/c/systemd/user/computer-watcher-recorder.service');
    expect(p.configDir).toBe('/c/computer-watcher');
    expect(p.dataDir).toBe('/d/computer-watcher');
    expect(appPaths(rootsFrom({}, '/home/u')).autostart).toBe('/home/u/.config/autostart/computer-watcher.desktop');
    expect(appPaths(rootsFrom({ XDG_CACHE_HOME: '/k' }, '/home/u')).updaterCache).toBe('/k/computer-watcher-updater');
    expect(appPaths(rootsFrom({}, '/home/u')).updaterCache).toBe('/home/u/.cache/computer-watcher-updater');
    // anciens noms (restes d'avant le renommage)
    expect(p.legacy).toEqual({
      appImage: '/home/u/Applications/proc-watch.AppImage',
      autostart: '/c/autostart/proc-watch.desktop',
      desktop: '/d/applications/proc-watch.desktop',
      icon: '/d/icons/hicolor/512x512/apps/proc-watch.png',
      unit: '/c/systemd/user/proc-watch-recorder.service',
      configDir: '/c/proc-watch',
      dataDir: '/d/proc-watch',
      updaterCache: '/home/u/.cache/proc-watch-updater',
    });
    // M-2 : XDG relatifs ignorés
    expect(rootsFrom({ XDG_CONFIG_HOME: 'c', XDG_DATA_HOME: './d', XDG_CACHE_HOME: 'k' }, '/home/u')).toEqual({
      home: '/home/u', configHome: '/home/u/.config', dataHome: '/home/u/.local/share', cacheHome: '/home/u/.cache', foreign: [],
    });
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
    expect(readdirSync(join(roots.home, 'Applications'))).toEqual(['computer-watcher.AppImage']);
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
    expect(r.warnings.join('\n')).toMatch(/applications\/computer-watcher\.desktop.*pas été créé par Computer Watcher/);
    expect(r.warnings.join('\n')).toMatch(/autostart\/computer-watcher\.desktop.*pas été créé par Computer Watcher/);
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
  test('activer : ~/.config/autostart/computer-watcher.desktop avec --hidden ; désactiver : retiré ; deux fois : idempotent', () => {
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
    expect(() => setAutostart(true, '/x/proc-watch.AppImage', roots)).toThrow(/pas été créé par Computer Watcher/);
    expect(readFileSync(p, 'utf8')).toContain('my-own');
  });
  test('reproduction I1 [3] : ~/.config/autostart remplacé par un lien → refusé, fichier du dossier visé intact', () => {
    const victimDir = join(roots.home, 'victim-dir');
    mkdirSync(victimDir);
    writeFileSync(join(victimDir, 'computer-watcher.desktop'), 'FOREIGN in victim dir\n');
    mkdirSync(roots.configHome, { recursive: true });
    symlinkSync(victimDir, join(roots.configHome, 'autostart'));
    expect(() => setAutostart(true, '/x/proc-watch.AppImage', roots)).toThrow(/lien symbolique/);
    expect(readFileSync(join(victimDir, 'computer-watcher.desktop'), 'utf8')).toBe('FOREIGN in victim dir\n');
  });
  test('désactiver : un fichier sans X-ProcWatch-Managed=1 (pas créé par l’app) reste', () => {
    mkdirSync(join(roots.configHome, 'autostart'), { recursive: true });
    writeFileSync(appPaths(roots).autostart, '[Desktop Entry]\nExec=autre\n');
    expect(() => setAutostart(false, null, roots)).toThrow(/pas été créé par Computer Watcher/);
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
    writeFileSync(join(p.configDir, 'migration.json'), '{}');
    mkdirSync(join(p.configDir, 'GPUCache/sub'), { recursive: true });
    writeFileSync(join(p.configDir, 'GPUCache/sub/data_0'), 'x');
    mkdirSync(join(p.configDir, 'Local Storage/leveldb'), { recursive: true });
    writeFileSync(join(p.configDir, 'Preferences'), '{}');
    symlinkSync('host-123', join(p.configDir, 'SingletonLock'));
    const plan = uninstallPlan(roots, { history: false, config: true });
    for (const n of ['updater.json', '.updaterId', 'migration.json', 'GPUCache', 'Local Storage', 'Preferences', 'SingletonLock']) expect(plan.map((i) => i.path)).toContain(join(p.configDir, n));
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
    plan.splice(1, 0, { kind: 'history', path: join(p.dataDir, '..', 'computer-watcher', '..', 'victim.txt'), label: 'x' });
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
    writeFileSync(join(victimDir, 'computer-watcher.AppImage'), 'autre');
    writeFileSync(join(victimDir, 'computer-watcher.png'), 'autre');
    rmSync(join(roots.home, 'Applications'), { recursive: true });
    symlinkSync(victimDir, join(roots.home, 'Applications'));
    rmSync(dirname(p.icon), { recursive: true });
    symlinkSync(victimDir, dirname(p.icon));
    const r = await runUninstall(uninstallPlan(roots, { history: false, config: false }), roots, { service: okService() });
    expect(readFileSync(join(victimDir, 'computer-watcher.AppImage'), 'utf8')).toBe('autre');
    expect(readFileSync(join(victimDir, 'computer-watcher.png'), 'utf8')).toBe('autre');
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
    expect(uninstallSummary([], { deb: true }).detail).toMatch(/apt remove computer-watcher/);
    expect(s.message).toBe('Désinstaller Computer Watcher ?');
    expect(s.detail).toMatch(/Computer Watcher se fermera ensuite/);
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
    expect(await stopRecorderForUninstall({ unitPath: join(roots.configHome, 'systemd/user/computer-watcher-recorder.service'), run: run(''), disabled: false })).toEqual({ stopped: false, error: null });
  });
  test('unité non chargée mais lien default.target.wants présent : erreur', async () => {
    const unit = join(roots.configHome, 'systemd/user/computer-watcher-recorder.service');
    mkdirSync(join(dirname(unit), 'default.target.wants'), { recursive: true });
    symlinkSync(unit, join(dirname(unit), 'default.target.wants/computer-watcher-recorder.service'));
    expect((await stopRecorderForUninstall({ unitPath: unit, run: run(''), disabled: false })).error).toMatch(/default\.target\.wants/);
  });
  test('notre unité : disable --now', async () => {
    expect(await stopRecorderForUninstall({ unitPath: '/c/u.service', run: run('/c/u.service'), disabled: false })).toEqual({ stopped: true, error: null });
    expect(calls[1]).toEqual(['disable', '--now', 'computer-watcher-recorder.service']);
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

describe('cache de l’updater (computer-watcher-updater) avec « Supprimer la configuration »', () => {
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
  const tools = sweepTools(existsSync)!;
  const runSweep = (dir: string) => {
    const c = postExitSweepCommand(999_999_999, dir, tools); // PID inexistant : pas d'attente
    execFileSync(c.cmd, c.args, { env: c.env });
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
    const c = postExitSweepCommand(42, '/c/proc-watch$(id)', tools);
    expect(c.args[1]).not.toContain('proc-watch$(id)');
    expect(c.args.slice(-2)).toEqual(['42', '/c/proc-watch$(id)']);
  });
  test('I-A : aucun PATH hérité — env { PATH: /usr/bin:/bin, LC_ALL: C }, sleep/rm/rmdir par chemin absolu', () => {
    const c = postExitSweepCommand(42, '/c/proc-watch', tools);
    expect(c.cmd).toBe('/bin/sh');
    expect(c.env).toEqual({ PATH: '/usr/bin:/bin', LC_ALL: 'C' });
    const script = c.args[1]!;
    for (const t of ['sleep', 'rm', 'rmdir']) expect(script).toContain(tools[t as 'sleep']);
    // aucune commande externe appelée par son nom nu (seules des commandes intégrées au shell : kill, cd, pwd, [, exit)
    expect(script).not.toMatch(/(^|[\s;(|&])(sleep|rm|rmdir|env|ls|test|cat)\s/m);
    for (const w of ['kill -0', 'cd -P', 'pwd -P']) expect(script).toContain(w);
  });
  test('M-1 : dossier remplacé par un lien après la vérification → cd -P puis pwd -P différent : rien supprimé', () => {
    const real = join(roots.home, 'ailleurs');
    mkdirSync(join(real, 'Session Storage'), { recursive: true });
    writeFileSync(join(real, 'Session Storage/x'), 'x');
    const expected = join(roots.configHome, 'proc-watch');
    mkdirSync(roots.configHome, { recursive: true });
    symlinkSync(real, expected); // le chemin attendu est maintenant un lien vers un autre dossier
    runSweep(expected);
    expect(existsSync(join(real, 'Session Storage/x'))).toBe(true);
  });
});

describe('renommage : restes à l’ancien nom (proc-watch)', () => {
  const managed = (path: string, exec: string, args: string[] = []) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, desktopEntryContent(exec, { args, autostart: args.length > 0 }));
  };

  test('la désinstallation retire aussi les restes marqués à l’ancien nom, jamais une entrée non marquée', async () => {
    const p = appPaths(roots);
    managed(p.legacy.desktop, p.legacy.appImage);
    mkdirSync(dirname(p.legacy.autostart), { recursive: true });
    writeFileSync(p.legacy.autostart, '[Desktop Entry]\nName=autre\nExec=/usr/bin/autre\n'); // non marquée
    mkdirSync(dirname(p.legacy.icon), { recursive: true });
    writeFileSync(p.legacy.icon, 'png');
    mkdirSync(dirname(p.legacy.appImage), { recursive: true });
    writeFileSync(p.legacy.appImage, AI('v0.1.3'));
    const plan = uninstallPlan(roots, { history: false, config: false });
    expect(plan.map((i) => i.path)).toEqual([p.legacy.desktop, p.legacy.icon, p.legacy.appImage]);
    const res = await runUninstall(plan, roots, { service: okService() });
    expect(res.failed).toEqual([]);
    expect(res.done).toBe(true);
    expect(existsSync(p.legacy.desktop)).toBe(false);
    expect(existsSync(p.legacy.icon)).toBe(false);
    expect(existsSync(p.legacy.appImage)).toBe(false);
    expect(readFileSync(p.legacy.autostart, 'utf8')).toContain('Name=autre');
  });

  test('ancienne unité, anciens dossiers d’historique, de config et de cache : listés et retirés sous les mêmes contrôles', async () => {
    const p = await fullInstall();
    const L = p.legacy;
    mkdirSync(dirname(L.unit), { recursive: true });
    writeFileSync(L.unit, '[Unit]\n');
    mkdirSync(L.dataDir, { recursive: true });
    writeFileSync(join(L.dataDir, 'metrics.db'), 'ancien');
    writeFileSync(join(L.dataDir, 'notes-perso.txt'), 'à moi');
    mkdirSync(L.configDir, { recursive: true });
    writeFileSync(join(L.configDir, 'config.json'), '{}');
    mkdirSync(join(L.updaterCache, 'pending'), { recursive: true });
    const stopped: string[] = [];
    const plan = uninstallPlan(roots, { history: true, config: true });
    const paths = plan.map((i) => i.path);
    for (const x of [L.unit, join(L.dataDir, 'metrics.db'), L.dataDir, join(L.configDir, 'config.json'), L.configDir, L.updaterCache]) expect(paths).toContain(x);
    expect(paths).not.toContain(join(L.dataDir, 'notes-perso.txt'));
    expect(plan.at(-1)!.path).toBe(p.appImage);
    const r = await runUninstall(plan, roots, { service: { stop: async (u) => (stopped.push(u), null), reload: async () => {} } });
    expect(r.failed).toEqual([]);
    expect(stopped).toEqual([p.unit, L.unit]);
    for (const x of [L.unit, join(L.dataDir, 'metrics.db'), L.configDir, L.updaterCache]) expect(existsSync(x), x).toBe(false);
    expect(readFileSync(join(L.dataDir, 'notes-perso.txt'), 'utf8')).toBe('à moi');
    expect(r.kept.map((k) => k.path)).toContain(L.dataDir);
  });

  test('plan forgé : un chemin voisin de l’ancien nom reste hors de la liste autorisée', async () => {
    const p = appPaths(roots);
    const victim = join(roots.configHome, 'proc-watch-autre', 'config.json');
    mkdirSync(dirname(victim), { recursive: true });
    writeFileSync(victim, 'précieux');
    const r = await runUninstall([{ kind: 'config', path: victim, label: 'x' }, { kind: 'config', path: dirname(victim), label: 'x', dir: true }], roots, { service: okService() });
    expect(r.failed).toHaveLength(2);
    expect(readFileSync(victim, 'utf8')).toBe('précieux');
    expect(p.legacy.configDir).not.toBe(dirname(victim));
  });

  test('arrêt de l’ancienne unité : systemctl vise proc-watch-recorder.service', async () => {
    const calls: string[][] = [];
    const unit = appPaths(roots).legacy.unit;
    const run = async (args: string[]) => (calls.push(args), { ok: true, stdout: args[0] === 'show' ? `${unit}\n` : '' });
    expect(await stopRecorderForUninstall({ unitPath: unit, run, disabled: false })).toEqual({ stopped: true, error: null });
    expect(calls).toEqual([['show', '-p', 'FragmentPath', '--value', 'proc-watch-recorder.service'], ['disable', '--now', 'proc-watch-recorder.service']]);
  });
});

describe('revue M4 : XDG partiel, la désinstallation ne liste jamais les dossiers d’une autre racine', () => {
  test('config temporaire, données et cache par défaut (les vrais) : seuls config, menu de HOME… et unité de la racine de config', async () => {
    const home = roots.home;
    const cfg = join(home, 'tmpcfg');
    const r = rootsFrom({ XDG_CONFIG_HOME: cfg }, home);
    expect(r.foreign).toEqual(['data', 'cache']);
    const p = appPaths(r);
    for (const d of [p.dataDir, p.legacy.dataDir, p.configDir, p.updaterCache, p.legacy.updaterCache]) mkdirSync(d, { recursive: true });
    writeFileSync(join(p.dataDir, 'metrics.db'), 'vrai historique');
    writeFileSync(join(p.legacy.dataDir, 'metrics.db'), 'vrai historique');
    writeFileSync(join(p.configDir, 'config.json'), '{}');
    mkdirSync(dirname(p.desktop), { recursive: true });
    writeFileSync(p.desktop, desktopEntryContent('/x/app'));
    const plan = uninstallPlan(r, { history: true, config: true });
    const paths = plan.map((i) => i.path);
    expect(paths.filter((x) => x.startsWith(r.dataHome) || x.startsWith(r.cacheHome))).toEqual([]);
    expect(paths).toContain(join(p.configDir, 'config.json'));
    // plan forgé vers la racine étrangère : refusé à l'exécution
    const res = await runUninstall([{ kind: 'history', path: join(p.dataDir, 'metrics.db'), label: 'x' }, { kind: 'desktop', path: p.desktop, label: 'x' }], r, { service: okService() });
    expect(res.failed.map((f) => f.path)).toEqual([join(p.dataDir, 'metrics.db'), p.desktop]);
    expect(readFileSync(join(p.dataDir, 'metrics.db'), 'utf8')).toBe('vrai historique');
  });
  test('racines cohérentes : rien d’étranger', () => {
    expect(rootsFrom({}, '/home/u').foreign).toEqual([]);
    expect(rootsFrom({ XDG_CONFIG_HOME: '/c', XDG_DATA_HOME: '/d', XDG_CACHE_HOME: '/k' }, '/home/u').foreign).toEqual([]);
    expect(rootsFrom({ XDG_DATA_HOME: '/d' }, '/home/u').foreign).toEqual(['data']);
  });
});
