import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import {
  appPaths, appImageSource, autostartState, deleteOriginal, installAppImage, launchTarget, rootsFrom, runUninstall, setAutostart, stopRecorderForUninstall,
  uninstallPlan, uninstallSummary, type Roots,
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

const fakeAppImage = (name = 'proc-watch-1.0.0-x86_64.AppImage', body = 'ELF-appimage-v1') => {
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
  });
});

describe('mode AppImage (jamais APPIMAGE seul)', () => {
  test('APPIMAGE + APPDIR + binaire dans APPDIR (realpath) : chemin de l’AppImage', () => {
    const appdir = join(roots.home, 'mnt');
    mkdirSync(appdir);
    writeFileSync(join(appdir, 'proc-watch'), '');
    const src = fakeAppImage();
    expect(appImageSource({ APPIMAGE: src, APPDIR: appdir }, join(appdir, 'proc-watch'))).toBe(src);
  });
  test('APPDIR absent, binaire hors d’APPDIR, APPIMAGE relatif ou absent : null', () => {
    const appdir = join(roots.home, 'mnt');
    mkdirSync(appdir);
    writeFileSync(join(appdir, 'proc-watch'), '');
    const src = fakeAppImage();
    expect(appImageSource({ APPIMAGE: src }, join(appdir, 'proc-watch'))).toBeNull();
    expect(appImageSource({ APPIMAGE: src, APPDIR: appdir }, '/usr/bin/node')).toBeNull();
    expect(appImageSource({ APPIMAGE: 'x.AppImage', APPDIR: appdir }, join(appdir, 'proc-watch'))).toBeNull();
    expect(appImageSource({ APPDIR: appdir }, join(appdir, 'proc-watch'))).toBeNull();
    // préfixe trompeur : /…/mnt-evil n'est pas dans /…/mnt
    mkdirSync(join(roots.home, 'mnt-evil'));
    writeFileSync(join(roots.home, 'mnt-evil', 'proc-watch'), '');
    expect(appImageSource({ APPIMAGE: src, APPDIR: appdir }, join(roots.home, 'mnt-evil', 'proc-watch'))).toBeNull();
  });
});

describe('installer l’AppImage', () => {
  test('copie 0755 dans ~/Applications, entrée de menu vers la copie, aucun fichier temporaire', async () => {
    const src = fakeAppImage();
    const r = await installAppImage({ source: src, roots });
    const p = appPaths(roots);
    expect(r).toMatchObject({ status: 'installed', dest: p.appImage, runningFromCopy: false, canDeleteSource: true });
    expect(readFileSync(p.appImage, 'utf8')).toBe('ELF-appimage-v1');
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
    await installAppImage({ source: fakeAppImage('a.AppImage', 'v1'), roots });
    const r = await installAppImage({ source: fakeAppImage('b.AppImage', 'v2'), roots });
    expect(r.status).toBe('updated');
    expect(readFileSync(r.dest, 'utf8')).toBe('v2');
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

  test('source absente : erreur en français', async () => {
    await expect(installAppImage({ source: join(dl, 'nope.AppImage'), roots })).rejects.toThrow(/AppImage introuvable/);
  });
});

describe('supprimer le fichier téléchargé (accord explicite)', () => {
  test('supprime exactement le fichier d’origine, une fois la copie vérifiée identique', async () => {
    const src = fakeAppImage();
    const other = fakeAppImage('autre.AppImage', 'x');
    const r = await installAppImage({ source: src, roots });
    await deleteOriginal({ source: src, dest: r.dest });
    expect(existsSync(src)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(r.dest)).toBe(true);
  });
  test('refuse si la source est la copie installée', async () => {
    const r = await installAppImage({ source: fakeAppImage(), roots });
    await expect(deleteOriginal({ source: r.dest, dest: r.dest })).rejects.toThrow(/copie installée/);
    expect(existsSync(r.dest)).toBe(true);
  });
  test('refuse si la copie diffère (rien supprimé)', async () => {
    const src = fakeAppImage();
    const r = await installAppImage({ source: src, roots });
    writeFileSync(src, 'modifié');
    await expect(deleteOriginal({ source: src, dest: r.dest })).rejects.toThrow(/ne correspond pas/);
    expect(existsSync(src)).toBe(true);
  });
  test('refuse un lien symbolique (jamais suivi)', async () => {
    const real = fakeAppImage();
    const r = await installAppImage({ source: real, roots });
    const link = join(dl, 'lien.AppImage');
    symlinkSync(real, link);
    await expect(deleteOriginal({ source: link, dest: r.dest })).rejects.toThrow(/lien symbolique/);
    expect(existsSync(real)).toBe(true);
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

describe('arrêt du service à la désinstallation', () => {
  const calls: string[][] = [];
  const run = (frag: string) => async (args: string[]) => {
    calls.push(args);
    return { ok: true, stdout: args[0] === 'show' ? `${frag}\n` : '' };
  };
  beforeEach(() => void (calls.length = 0));

  test('PROC_WATCH_NO_RECORDER_SYNC : aucun appel systemctl', async () => {
    expect(await stopRecorderForUninstall({ unitPath: '/c/u.service', run: run('/c/u.service'), disabled: true })).toEqual({ stopped: false, error: null });
    expect(calls).toEqual([]);
  });
  test('unité chargée depuis un autre fichier (autre XDG_CONFIG_HOME) : jamais arrêtée', async () => {
    expect(await stopRecorderForUninstall({ unitPath: '/tmp-cfg/u.service', run: run('/home/u/.config/systemd/user/u.service'), disabled: false })).toEqual({ stopped: false, error: null });
    expect(calls.map((c) => c[0])).toEqual(['show']);
  });
  test('unité non chargée : rien à arrêter', async () => {
    expect(await stopRecorderForUninstall({ unitPath: '/c/u.service', run: run(''), disabled: false })).toEqual({ stopped: false, error: null });
  });
  test('notre unité : disable --now', async () => {
    expect(await stopRecorderForUninstall({ unitPath: '/c/u.service', run: run('/c/u.service'), disabled: false })).toEqual({ stopped: true, error: null });
    expect(calls[1]).toEqual(['disable', '--now', 'proc-watch-recorder.service']);
  });
  test('disable qui échoue : erreur signalée', async () => {
    const failing = async (args: string[]) => (args[0] === 'show' ? { ok: true, stdout: '/c/u.service' } : { ok: false, stdout: '' });
    expect((await stopRecorderForUninstall({ unitPath: '/c/u.service', run: failing, disabled: false })).error).toMatch(/échoué/);
  });
});
