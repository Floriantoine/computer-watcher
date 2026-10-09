// Migration proc-watch → computer-watcher, exécutée sur de vrais fichiers : HOME et XDG sous ~/.cache/pw-migrate-* (jamais
// les vrais dossiers de l'utilisateur), systemctl simulé (jamais le vrai service), retirés à la fin.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { appPaths, rootsFrom, verifyAndDeleteOriginal, type Roots } from './appInstall';
import { chmodSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DELETE_CONSENT_TTL_MS, parseOnboardingFile } from '../core/onboarding';
import { desktopEntryContent } from './desktopEntry';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, readlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { legacyLockHolder, migrateEarly, migrateName, realDirUser, realLegacyInstance, waitPidGone, waitWhile, type MigrateDeps, type SystemctlSync } from './migrateName';
import { parseMigrationState } from '../core/nameMigration';

const cache = join(homedir(), '.cache');
mkdirSync(cache, { recursive: true });
const base = mkdtempSync(join(cache, 'pw-migrate-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
let roots: Roots;
let run: string;
beforeEach(() => {
  const home = join(base, `h${++n}`);
  mkdirSync(home, { recursive: true });
  roots = rootsFrom({}, home);
  run = join(home, 'run');
  mkdirSync(run);
});

const P = () => appPaths(roots);
const LEGACY = 'proc-watch-recorder.service';

/** systemctl simulé : enregistre les appels et, pour chacun, si l'ancien dossier de config était encore en place. */
function fakeCtl(o: { frag?: string; showOk?: boolean; active?: string; activeSeq?: string[]; failOn?: string } = {}) {
  const calls: string[][] = [];
  const legacyThere: boolean[] = [];
  const ctl: SystemctlSync = (args) => {
    calls.push(args);
    legacyThere.push(existsSync(P().legacy.configDir));
    if (o.failOn && args[0] === o.failOn) return { ok: false, stdout: '' };
    if (args[0] === 'show') return o.showOk === false ? { ok: false, stdout: '' } : { ok: true, stdout: `${o.frag ?? ''}\n` };
    if (args[0] === 'is-active') {
      const a = o.activeSeq?.shift() ?? o.active ?? 'inactive';
      return { ok: a === 'active', stdout: `${a}\n` };
    }
    if (args[0] === 'is-enabled') return { ok: true, stdout: 'enabled\n' };
    return { ok: true, stdout: '' };
  };
  return { ctl, calls, legacyThere };
}

function deps(over: Partial<MigrateDeps> = {}): MigrateDeps & { written: number } {
  const d = {
    written: 0,
    roots,
    env: { XDG_RUNTIME_DIR: run } as NodeJS.ProcessEnv,
    systemctl: fakeCtl().ctl,
    mountinfo: () => '',
    legacyInstance: () => null,
    dirUser: () => null,
    relaunching: false,
    sleep: () => {},
    writeNewService: async () => {
      d.written++;
      mkdirSync(dirname(P().unit), { recursive: true });
      writeFileSync(P().unit, '[Unit]\nDescription=Computer Watcher recorder\n');
    },
    ownAppImage: () => null,
    relaunch: async () => {},
    now: () => 1_000_000,
    ...over,
  };
  return d;
}

/** Ancienne installation : config (config.json), données (metrics.db + -wal), cache de l'updater, dossier d'exécution. */
function legacyInstall() {
  const L = P().legacy;
  mkdirSync(L.configDir, { recursive: true });
  writeFileSync(join(L.configDir, 'config.json'), '{"recorder":{"tmpfsAlertMB":1234}}');
  mkdirSync(join(L.configDir, 'Local Storage'), { recursive: true });
  mkdirSync(L.dataDir, { recursive: true });
  writeFileSync(join(L.dataDir, 'metrics.db'), Buffer.from([1, 2, 3, 4, 5]));
  writeFileSync(join(L.dataDir, 'metrics.db-wal'), Buffer.from([9, 8, 7]));
  mkdirSync(join(L.updaterCache, 'pending'), { recursive: true });
  mkdirSync(join(run, 'proc-watch'));
  writeFileSync(join(run, 'proc-watch', 'focus-abc.json'), '{}');
  return L;
}

const stateOf = (dir: string) => parseMigrationState(existsSync(join(dir, 'migration.json')) ? readFileSync(join(dir, 'migration.json'), 'utf8') : null);
const managedEntry = (path: string, exec: string, args: string[] = []) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, desktopEntryContent(exec, { args, autostart: args.length > 0 }));
};

describe('dossiers', () => {
  test('ancien config + données → déplacés à l’identique, anciens absents, migration.json complet', async () => {
    const L = legacyInstall();
    const r = await migrateName(deps());
    expect(r.status).toBe('done');
    const p = P();
    expect(readFileSync(join(p.configDir, 'config.json'), 'utf8')).toBe('{"recorder":{"tmpfsAlertMB":1234}}');
    expect(readFileSync(join(p.dataDir, 'metrics.db'))).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    expect(readFileSync(join(p.dataDir, 'metrics.db-wal'))).toEqual(Buffer.from([9, 8, 7]));
    expect(existsSync(join(p.updaterCache, 'pending'))).toBe(true);
    // revue C1 : le dossier d'exécution (fichiers éphémères) n'est jamais déplacé
    expect(readFileSync(join(run, 'proc-watch', 'focus-abc.json'), 'utf8')).toBe('{}');
    expect(existsSync(join(run, 'computer-watcher'))).toBe(false);
    for (const x of [L.configDir, L.dataDir, L.updaterCache]) expect(existsSync(x), x).toBe(false);
    expect(stateOf(p.configDir)).toMatchObject({ done: ['stop-legacy-service', 'move-dirs', 'new-service', 'desktop', 'appimage'], errors: {}, leftInPlace: [] });
  });

  test('Review Focus 1 : nouveau dossier de config déjà créé mais vide → remplacé par l’ancien', async () => {
    legacyInstall();
    mkdirSync(P().configDir, { recursive: true });
    const r = await migrateName(deps());
    expect(r.status).toBe('done');
    expect(readFileSync(join(P().configDir, 'config.json'), 'utf8')).toContain('1234');
    expect(existsSync(P().legacy.configDir)).toBe(false);
  });

  test('nouveau dossier de config non vide → rien déplacé ni fusionné, ancien laissé en place et signalé', async () => {
    const L = legacyInstall();
    mkdirSync(P().configDir, { recursive: true });
    writeFileSync(join(P().configDir, 'config.json'), '{"autre":true}');
    const r = await migrateName(deps());
    expect(r.status).toBe('partial');
    expect(r.leftInPlace).toEqual([L.configDir]);
    expect(readFileSync(join(P().configDir, 'config.json'), 'utf8')).toBe('{"autre":true}');
    expect(readFileSync(join(L.configDir, 'config.json'), 'utf8')).toContain('1234');
    expect(existsSync(join(P().dataDir, 'metrics.db'))).toBe(true); // les autres dossiers suivent
  });

  test('ancien dossier de config en lien symbolique → refusé, cible du lien intacte, rien déplacé', async () => {
    const L = P().legacy;
    const victim = join(roots.home, 'victime');
    mkdirSync(victim);
    writeFileSync(join(victim, 'config.json'), 'précieux');
    mkdirSync(dirname(L.configDir), { recursive: true });
    symlinkSync(victim, L.configDir);
    const r = await migrateName(deps());
    expect(r.status).toBe('partial');
    expect(r.errors['move-dirs']).toMatch(/lien symbolique/);
    expect(lstatSync(L.configDir).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(victim, 'config.json'), 'utf8')).toBe('précieux');
    expect(existsSync(P().configDir)).toBe(false);
  });

  test('montage sous l’ancien dossier de données (mountinfo) → refusé, rien déplacé', async () => {
    const L = legacyInstall();
    mkdirSync(join(L.dataDir, 'mnt'));
    const real = realpathSync(join(L.dataDir, 'mnt'));
    const r = await migrateName(deps({ mountinfo: () => `1 2 0:5 / ${real} rw - tmpfs t rw\n` }));
    expect(r.status).toBe('partial');
    expect(r.errors['move-dirs']).toMatch(/point de montage/);
    expect(existsSync(join(L.dataDir, 'metrics.db'))).toBe(true);
    expect(existsSync(P().dataDir)).toBe(false);
  });

  test('échec puis reprise : la deuxième tentative termine (idempotente), sans rien refaire de ce qui est fait', async () => {
    const L = legacyInstall();
    mkdirSync(join(L.dataDir, 'mnt'));
    const real = realpathSync(join(L.dataDir, 'mnt'));
    expect((await migrateName(deps({ mountinfo: () => `1 2 0:5 / ${real} rw - tmpfs t rw\n` }))).status).toBe('partial');
    // état gardé dans le dossier de config résolu (ici le nouveau, déjà déplacé)
    expect(stateOf(P().configDir)?.errors['move-dirs']).toMatch(/point de montage/);
    const f = fakeCtl();
    const r = await migrateName(deps({ systemctl: f.ctl }));
    expect(r.status).toBe('done');
    expect(existsSync(join(P().dataDir, 'metrics.db'))).toBe(true);
    expect(f.calls).toEqual([]); // l'arrêt de l'ancien service était déjà fait
  });

  test('dossier de config pas déplacé : l’état reste dans l’ancien dossier (l’app continue de l’utiliser)', async () => {
    const L = legacyInstall();
    const r = await migrateName(deps({ systemctl: fakeCtl({ showOk: false }).ctl }));
    expect(r.status).toBe('partial');
    expect(existsSync(P().configDir)).toBe(false);
    expect(stateOf(L.configDir)?.errors['stop-legacy-service']).toMatch(/show a échoué/);
  });
});

describe('ancien service (échec fermé)', () => {
  const withUnit = () => {
    const L = legacyInstall();
    mkdirSync(dirname(L.unit), { recursive: true });
    writeFileSync(L.unit, '[Unit]\nDescription=proc-watch recorder\n');
    mkdirSync(join(dirname(L.unit), 'default.target.wants'), { recursive: true });
    symlinkSync(L.unit, join(dirname(L.unit), 'default.target.wants', LEGACY));
    return L;
  };

  test('Review Focus 3 / revue M1 : état relevé, stop, is-active = inactive, puis disable, tout avant le moindre déplacement', async () => {
    const L = withUnit();
    const f = fakeCtl({ frag: L.unit });
    const r = migrateEarly(deps({ systemctl: f.ctl }));
    expect(r.errors).toEqual({});
    expect(f.calls.slice(0, 6)).toEqual([
      ['show', '-p', 'FragmentPath', '--value', LEGACY], ['is-enabled', LEGACY], ['is-active', LEGACY], ['stop', LEGACY], ['is-active', LEGACY], ['disable', LEGACY],
    ]);
    expect(f.legacyThere.slice(0, 6)).toEqual([true, true, true, true, true, true]);
    expect(existsSync(L.configDir)).toBe(false);
  });

  test('is-active répond active (Restart= l’a relancé) → échec fermé, rien déplacé', async () => {
    const L = withUnit();
    const r = await migrateName(deps({ systemctl: fakeCtl({ frag: L.unit, active: 'active' }).ctl }));
    expect(r.status).toBe('partial');
    expect(r.errors['stop-legacy-service']).toMatch(/toujours actif/);
    expect(existsSync(join(L.configDir, 'config.json'))).toBe(true);
    expect(existsSync(P().configDir)).toBe(false);
    expect(existsSync(L.unit)).toBe(true);
  });

  test('unité chargée depuis un autre fichier → échec fermé, jamais arrêtée, rien déplacé', async () => {
    const L = withUnit();
    const f = fakeCtl({ frag: '/etc/systemd/user/proc-watch-recorder.service' });
    const r = await migrateName(deps({ systemctl: f.ctl }));
    expect(r.errors['stop-legacy-service']).toMatch(/chargé depuis \/etc\/systemd\/user/);
    expect(f.calls.map((c) => c[0])).toEqual(['show']);
    expect(existsSync(L.configDir)).toBe(true);
  });

  test.each(['disable', 'stop', 'show'])('%s qui échoue → échec fermé, rien déplacé', async (verb) => {
    const L = withUnit();
    const r = await migrateName(deps({ systemctl: fakeCtl({ frag: L.unit, failOn: verb }).ctl }));
    expect(r.status).toBe('partial');
    expect(r.errors['stop-legacy-service']).toBeTruthy();
    expect(existsSync(L.configDir)).toBe(true);
  });

  test('nouveau service écrit, puis ancienne unité et son lien default.target.wants retirés (unité à nous)', async () => {
    const L = withUnit();
    const f = fakeCtl({ frag: L.unit });
    const d = deps({ systemctl: f.ctl });
    const r = await migrateName(d);
    expect(r.status).toBe('done');
    expect(d.written).toBe(1);
    expect(existsSync(P().unit)).toBe(true);
    expect(existsSync(L.unit)).toBe(false);
    expect(existsSync(join(dirname(L.unit), 'default.target.wants', LEGACY))).toBe(false);
    expect(f.calls.at(-1)).toEqual(['daemon-reload']);
  });

  test('nouveau service impossible à écrire → ancienne unité gardée (arrêtée), erreur', async () => {
    const L = withUnit();
    const r = await migrateName(deps({ systemctl: fakeCtl({ frag: L.unit }).ctl, writeNewService: async () => { throw new Error('EACCES'); } }));
    expect(r.status).toBe('partial');
    expect(r.errors['new-service']).toMatch(/EACCES/);
    expect(existsSync(L.unit)).toBe(true);
  });

  test('PROC_WATCH_NO_RECORDER_SYNC=1 : systemctl jamais appelé, étapes du service ignorées (et dit), dossiers et entrées migrés', async () => {
    const L = withUnit();
    managedEntry(L.desktop, L.appImage);
    const f = fakeCtl({ frag: L.unit });
    const d = deps({ systemctl: f.ctl, env: { XDG_RUNTIME_DIR: run, PROC_WATCH_NO_RECORDER_SYNC: '1' } });
    const r = await migrateName(d);
    expect(f.calls).toEqual([]);
    expect(d.written).toBe(0);
    expect(r.skipped['stop-legacy-service']).toMatch(/PROC_WATCH_NO_RECORDER_SYNC/);
    expect(r.skipped['new-service']).toMatch(/PROC_WATCH_NO_RECORDER_SYNC/);
    expect(r.status).toBe('done');
    expect(existsSync(join(P().configDir, 'config.json'))).toBe(true);
    expect(existsSync(P().desktop)).toBe(true);
    expect(existsSync(L.unit)).toBe(true); // jamais touchée sans systemctl
  });
});

describe('Review Focus 2 : ancienne instance encore ouverte', () => {
  test('différé : aucun appel systemctl, rien déplacé, aucun état écrit', async () => {
    const L = legacyInstall();
    const f = fakeCtl();
    const r = await migrateName(deps({ systemctl: f.ctl, legacyInstance: () => ({ pid: 4242, name: 'proc-watch' }) }));
    expect(r.status).toBe('deferred');
    expect(r.detail).toMatch(/proc-watch \(pid 4242\)/); // revue M3
    expect(f.calls).toEqual([]);
    expect(existsSync(L.configDir)).toBe(true);
    expect(existsSync(P().configDir)).toBe(false);
    expect(existsSync(join(L.configDir, 'migration.json'))).toBe(false);
  });

  test('verrou d’instance de l’ancien dossier (SingletonLock → hôte-pid) : tenu seulement si ce pid est l’app, sous ses deux noms ou le même exécutable', () => {
    const comm = (pid: number) => ({ 10: 'proc-watch', 11: 'electron', 12: 'bash', 14: 'computer-watche', 15: 'renommé' } as Record<number, string>)[pid] ?? null;
    const exe = (pid: number) => (pid === 15 ? '/opt/computer-watcher/computer-watcher' : '/usr/bin/x');
    const o = { hostname: 'mon-pc', selfPid: 99, comm, exe, selfExe: '/opt/computer-watcher/computer-watcher' };
    expect(legacyLockHolder({ ...o, lockTarget: 'mon-pc-10' })).toEqual({ pid: 10, name: 'proc-watch' });
    expect(legacyLockHolder({ ...o, lockTarget: 'mon-pc-11' })).toEqual({ pid: 11, name: 'electron' }); // version de développement
    expect(legacyLockHolder({ ...o, lockTarget: 'mon-pc-14' })).toEqual({ pid: 14, name: 'computer-watche' }); // revue I1 : nouveau nom
    expect(legacyLockHolder({ ...o, lockTarget: 'mon-pc-15' })).toEqual({ pid: 15, name: 'renommé' }); // revue I1 : même exécutable que nous
    expect(legacyLockHolder({ ...o, lockTarget: 'mon-pc-12' })).toBeNull(); // pid réutilisé par autre chose
    expect(legacyLockHolder({ ...o, lockTarget: 'mon-pc-13' })).toBeNull(); // processus disparu (verrou périmé)
    expect(legacyLockHolder({ ...o, lockTarget: 'autre-pc-10' })).toBeNull(); // autre machine (dossier partagé)
    expect(legacyLockHolder({ ...o, lockTarget: 'mon-pc-99' })).toBeNull(); // nous-mêmes
    expect(legacyLockHolder({ ...o, lockTarget: null })).toBeNull();
    expect(legacyLockHolder({ ...o, lockTarget: 'n’importe quoi' })).toBeNull();
  });

  test('relance (mise à jour, « Réessayer ») : attend la libération, au plus 10 s ; lancement normal : n’attend pas', () => {
    let left = 3;
    const slept: number[] = [];
    expect(waitWhile({ busy: () => (left-- > 0 ? 'x' : null), wait: true, sleep: (ms) => slept.push(ms) })).toBeNull();
    expect(slept).toEqual([250, 250, 250]);
    slept.length = 0;
    expect(waitWhile({ busy: () => 'x', wait: true, sleep: (ms) => slept.push(ms) })).toBe('x');
    expect(slept.reduce((a, b) => a + b, 0)).toBe(10_000);
    slept.length = 0;
    expect(waitWhile({ busy: () => 'x', wait: false, sleep: (ms) => slept.push(ms) })).toBe('x');
    expect(slept).toEqual([]);
  });
});

describe('entrées du menu et du démarrage automatique', () => {
  test('menu marqué → computer-watcher.desktop (même Exec), ancien et son icône retirés ; autostart --hidden gardé', async () => {
    const L = legacyInstall();
    const exec = join(roots.home, 'Apps', 'mon proc-watch.AppImage');
    managedEntry(L.desktop, exec);
    managedEntry(L.autostart, exec, ['--hidden']);
    mkdirSync(dirname(L.icon), { recursive: true });
    writeFileSync(L.icon, 'png');
    const icon = join(roots.home, 'icon.png');
    writeFileSync(icon, 'nouvelle icône');
    const r = await migrateName(deps({ iconPng: icon }));
    expect(r.status).toBe('done');
    const p = P();
    expect(readFileSync(p.desktop, 'utf8')).toBe(desktopEntryContent(exec));
    expect(readFileSync(p.autostart, 'utf8')).toBe(desktopEntryContent(exec, { args: ['--hidden'], autostart: true }));
    expect(readFileSync(p.icon, 'utf8')).toBe('nouvelle icône');
    for (const x of [L.desktop, L.autostart, L.icon]) expect(existsSync(x), x).toBe(false);
  });

  test('entrées à l’ancien nom sans marqueur (pas écrites par l’app) : jamais modifiées ni supprimées, signalées', async () => {
    const L = legacyInstall();
    mkdirSync(dirname(L.desktop), { recursive: true });
    writeFileSync(L.desktop, '[Desktop Entry]\nName=à moi\nExec=/usr/bin/x\n');
    mkdirSync(dirname(L.autostart), { recursive: true });
    symlinkSync(join(roots.home, 'ailleurs'), L.autostart);
    const r = await migrateName(deps());
    expect(r.status).toBe('partial');
    expect(r.leftInPlace).toEqual(expect.arrayContaining([L.desktop, L.autostart]));
    expect(readFileSync(L.desktop, 'utf8')).toContain('Name=à moi');
    expect(lstatSync(L.autostart).isSymbolicLink()).toBe(true);
    expect(existsSync(P().desktop)).toBe(false);
    expect(existsSync(P().autostart)).toBe(false);
  });

  test('nouvelle entrée de menu déjà présente et étrangère : jamais écrasée, ancienne gardée, erreur', async () => {
    const L = legacyInstall();
    managedEntry(L.desktop, '/x/app');
    mkdirSync(dirname(P().desktop), { recursive: true });
    writeFileSync(P().desktop, '[Desktop Entry]\nName=autre\n');
    const r = await migrateName(deps());
    expect(r.errors.desktop).toMatch(/pas été créé par Computer Watcher/);
    expect(readFileSync(P().desktop, 'utf8')).toContain('Name=autre');
    expect(existsSync(L.desktop)).toBe(true);
  });
});

describe('idempotence', () => {
  test('deuxième exécution après succès → rien, aucun appel', async () => {
    legacyInstall();
    expect((await migrateName(deps())).status).toBe('done');
    const f = fakeCtl();
    const d = deps({ systemctl: f.ctl, legacyInstance: () => ({ pid: 1, name: 'x' }) });
    expect((await migrateName(d)).status).toBe('nothing');
    expect(f.calls).toEqual([]);
    expect(d.written).toBe(0);
  });

  test('nouvelle installation (rien d’ancien) → rien, aucun dossier ni état créé', async () => {
    const f = fakeCtl();
    expect((await migrateName(deps({ systemctl: f.ctl }))).status).toBe('nothing');
    expect(f.calls).toEqual([]);
    expect(existsSync(P().configDir)).toBe(false);
  });

  test('ancre : app d’essai à XDG_CONFIG_HOME temporaire, mais données, menu, cache et exécution réels à l’ancien nom → rien touché', async () => {
    const L = P().legacy;
    mkdirSync(L.dataDir, { recursive: true });
    writeFileSync(join(L.dataDir, 'metrics.db'), 'vrai historique');
    managedEntry(L.desktop, '/x/vraie-app');
    mkdirSync(join(L.updaterCache, 'pending'), { recursive: true });
    mkdirSync(join(run, 'proc-watch'));
    const f = fakeCtl();
    expect((await migrateName(deps({ systemctl: f.ctl }))).status).toBe('nothing');
    expect(f.calls).toEqual([]);
    expect(readFileSync(join(L.dataDir, 'metrics.db'), 'utf8')).toBe('vrai historique');
    expect(existsSync(L.desktop)).toBe(true);
    expect(existsSync(P().dataDir)).toBe(false);
    expect(existsSync(P().desktop)).toBe(false);
    expect(readdirSync(run)).toEqual(['proc-watch']);
    expect(existsSync(P().configDir)).toBe(false);
  });

  test('ancre : sans ancien dossier de config ni de données, le cache et le dossier d’exécution ne sont jamais déplacés', async () => {
    mkdirSync(join(P().legacy.updaterCache, 'pending'), { recursive: true });
    mkdirSync(join(run, 'proc-watch'));
    expect((await migrateName(deps())).status).toBe('nothing');
    expect(existsSync(P().legacy.updaterCache)).toBe(true);
    expect(readdirSync(run)).toEqual(['proc-watch']);
  });
});

describe('copie AppImage (tâche 7)', () => {
  /** En-tête d'AppImage type 2 (ELF + « AI\x02 » à l'octet 8), suivi d'un corps. */
  const AI = (body: string) => Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 0x02]), Buffer.from(body)]);
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  /** v0.1.3 installée « comme une app », mise à jour sur place en 0.2.0 (même nom de fichier), menu et démarrage marqués. */
  function installedLegacy() {
    const L = legacyInstall();
    mkdirSync(dirname(L.appImage), { recursive: true });
    writeFileSync(L.appImage, AI('computer-watcher 0.2.0'));
    chmodSync(L.appImage, 0o755);
    writeFileSync(join(L.configDir, 'onboarding.json'), '{"version":1,"done":true}\n');
    managedEntry(L.desktop, L.appImage);
    managedEntry(L.autostart, L.appImage, ['--hidden']);
    return L;
  }

  test('lancée depuis ~/Applications/proc-watch.AppImage : copie 0755 même SHA-256, menu, démarrage et unité repointés, accord écrit, relance depuis la copie', async () => {
    const L = installedLegacy();
    mkdirSync(dirname(L.unit), { recursive: true });
    writeFileSync(L.unit, '[Unit]\n');
    const relaunched: string[] = [];
    const units: string[] = [];
    const d = deps({
      systemctl: fakeCtl({ frag: L.unit }).ctl,
      ownAppImage: () => L.appImage,
      relaunch: async (t) => void relaunched.push(t),
      writeNewService: async () => {
        // ExecStart : la copie installée si elle est utilisable (recorderAppImage), sinon l'AppImage lancée
        units.push(existsSync(P().appImage) ? P().appImage : L.appImage);
        mkdirSync(dirname(P().unit), { recursive: true });
        writeFileSync(P().unit, `ExecStart=${units.at(-1)}\n`);
      },
    });
    const r = await migrateName(d);
    expect(r.status).toBe('done');
    const p = P();
    expect(readFileSync(p.appImage)).toEqual(AI('computer-watcher 0.2.0'));
    expect(statSync(p.appImage).mode & 0o777).toBe(0o755);
    expect(readFileSync(p.desktop, 'utf8')).toBe(desktopEntryContent(p.appImage));
    expect(readFileSync(p.autostart, 'utf8')).toBe(desktopEntryContent(p.appImage, { args: ['--hidden'], autostart: true }));
    expect(readFileSync(p.unit, 'utf8')).toBe(`ExecStart=${p.appImage}\n`);
    for (const x of [L.desktop, L.autostart]) expect(existsSync(x), x).toBe(false);
    expect(existsSync(L.appImage)).toBe(true); // supprimée seulement par la nouvelle instance
    const ob = parseOnboardingFile(readFileSync(join(p.configDir, 'onboarding.json'), 'utf8'))!;
    expect(ob.done).toBe(true);
    expect(ob.deleteOriginal).toEqual({ path: L.appImage, sha256: sha(AI('computer-watcher 0.2.0')), ino: statSync(L.appImage).ino, expires: 1_000_000 + DELETE_CONSENT_TTL_MS });
    expect(relaunched).toEqual([p.appImage]);
    expect(stateOf(p.configDir)?.done).toContain('appimage');
  });

  test('la nouvelle instance supprime l’ancienne copie avec l’accord ; un document mis à sa place est refusé', async () => {
    const L = installedLegacy();
    await migrateName(deps({ ownAppImage: () => L.appImage }));
    const c = parseOnboardingFile(readFileSync(join(P().configDir, 'onboarding.json'), 'utf8'))!.deleteOriginal!;
    // document au même chemin (autre inode) : refusé
    rmSync(L.appImage);
    writeFileSync(L.appImage, 'mon document');
    await expect(verifyAndDeleteOriginal({ path: c.path, sha256: c.sha256, ino: c.ino, copy: P().appImage })).rejects.toThrow(/non supprimé/);
    expect(readFileSync(L.appImage, 'utf8')).toBe('mon document');
  });

  test('accord valide : l’ancienne copie identique est supprimée par la nouvelle instance', async () => {
    const L = installedLegacy();
    await migrateName(deps({ ownAppImage: () => L.appImage }));
    const c = parseOnboardingFile(readFileSync(join(P().configDir, 'onboarding.json'), 'utf8'))!.deleteOriginal!;
    await verifyAndDeleteOriginal({ path: c.path, sha256: c.sha256, ino: c.ino, copy: P().appImage });
    expect(existsSync(L.appImage)).toBe(false);
    expect(existsSync(P().appImage)).toBe(true);
  });

  test('lancée d’ailleurs (AppImage téléchargée, déjà computer-watcher.AppImage, .deb, sources) : étape faite, rien copié ni relancé', async () => {
    for (const own of [null, join(roots.home, 'Téléchargements/computer-watcher-0.2.0-x86_64.AppImage'), join(roots.home, 'Applications/computer-watcher.AppImage')]) {
      rmSync(roots.home, { recursive: true, force: true });
      mkdirSync(run, { recursive: true });
      const L = installedLegacy();
      const relaunched: string[] = [];
      const r = await migrateName(deps({ ownAppImage: () => own, relaunch: async (t) => void relaunched.push(t) }));
      expect(r.done).toContain('appimage');
      expect(relaunched).toEqual([]);
      expect(existsSync(L.appImage)).toBe(true);
      expect(existsSync(P().appImage)).toBe(false);
    }
  });

  test('ancienne copie inutilisable (pas une AppImage) : étape faite, rien copié', async () => {
    const L = legacyInstall();
    mkdirSync(dirname(L.appImage), { recursive: true });
    writeFileSync(L.appImage, '');
    const r = await migrateName(deps({ ownAppImage: () => L.appImage }));
    expect(r.done).toContain('appimage');
    expect(existsSync(P().appImage)).toBe(false);
  });

  test('relance impossible : l’app reste ouverte, accord retiré, ancienne copie gardée, message', async () => {
    const L = installedLegacy();
    const r = await migrateName(deps({ ownAppImage: () => L.appImage, relaunch: async () => { throw new Error('EACCES'); } }));
    expect(r.status).toBe('partial');
    expect(r.errors.appimage).toMatch(/EACCES/);
    expect(r.done).not.toContain('appimage');
    expect(existsSync(L.appImage)).toBe(true);
    expect(parseOnboardingFile(readFileSync(join(P().configDir, 'onboarding.json'), 'utf8'))!.deleteOriginal).toBeUndefined();
  });

  test('étapes précédentes en échec : pas de copie ni de relance', async () => {
    const L = installedLegacy();
    const relaunched: string[] = [];
    const r = await migrateName(deps({ ownAppImage: () => L.appImage, systemctl: fakeCtl({ showOk: false }).ctl, relaunch: async (t) => void relaunched.push(t) }));
    expect(r.status).toBe('partial');
    expect(relaunched).toEqual([]);
    expect(existsSync(P().appImage)).toBe(false);
  });
});

describe('revue de sécurité (C1, I1, M1)', () => {
  const kids: ChildProcess[] = [];
  afterAll(() => {
    for (const k of kids) k.kill();
  });
  const started = (c: ChildProcess) => {
    kids.push(c);
    return new Promise<void>((r) => setTimeout(r, 300));
  };

  test('[xdg] les 8 combinaisons XDG_CONFIG_HOME / XDG_DATA_HOME / XDG_RUNTIME_DIR : seule une installation cohérente migre, le dossier d’exécution jamais', () => {
    const rows: string[] = [];
    for (let i = 0; i < 8; i++) {
      const b = join(base, `xdg${n}-${i}`);
      const home = join(b, 'home');
      // « vrais » dossiers de l'utilisateur (racines par défaut sous ce HOME factice)
      const real = { cfg: join(home, '.config/proc-watch'), data: join(home, '.local/share/proc-watch'), cache: join(home, '.cache/proc-watch-updater'), run: join(b, 'run-real/proc-watch') };
      for (const d of Object.values(real)) mkdirSync(d, { recursive: true });
      writeFileSync(join(real.cfg, 'config.json'), '{}');
      writeFileSync(join(real.data, 'metrics.db'), 'DB');
      const env: NodeJS.ProcessEnv = { PROC_WATCH_NO_RECORDER_SYNC: '1', XDG_RUNTIME_DIR: join(b, 'run-real') };
      if (i & 1) {
        env.XDG_CONFIG_HOME = join(b, 'tmpcfg');
        mkdirSync(join(b, 'tmpcfg/proc-watch'), { recursive: true }); // ancienne version d'essai lancée avec cette config temporaire
        writeFileSync(join(b, 'tmpcfg/proc-watch/config.json'), '{}');
      }
      if (i & 2) mkdirSync((env.XDG_DATA_HOME = join(b, 'tmpdata')), { recursive: true });
      if (i & 4) mkdirSync((env.XDG_RUNTIME_DIR = join(b, 'tmprun')), { recursive: true });
      const r = migrateEarly(deps({ roots: rootsFrom(env, home), env, systemctl: fakeCtl().ctl, dirUser: (dir) => realDirUser(dir) }));
      const moved = Object.entries(real).filter(([, p]) => !existsSync(p)).map(([k]) => k);
      rows.push(`${i & 1 ? 'tmp' : 'unset'} ${i & 2 ? 'tmp' : 'unset'} ${i & 4 ? 'tmp' : 'real'} → ${r.status}${r.detail ? ' (XDG partiel)' : ''} ; déplacés : ${moved.join(',') || 'aucun'}`);
      if (i & 3) expect(r.detail, `combinaison ${i}`).toMatch(/XDG partiel/);
      expect(existsSync(real.run), `combinaison ${i} : exécution`).toBe(true);
    }
    expect(rows).toEqual([
      'unset unset real → done ; déplacés : cfg,data,cache',
      'tmp unset real → deferred (XDG partiel) ; déplacés : aucun',
      'unset tmp real → deferred (XDG partiel) ; déplacés : aucun',
      'tmp tmp real → deferred (XDG partiel) ; déplacés : aucun',
      'unset unset tmp → done ; déplacés : cfg,data,cache',
      'tmp unset tmp → deferred (XDG partiel) ; déplacés : aucun',
      'unset tmp tmp → deferred (XDG partiel) ; déplacés : aucun',
      'tmp tmp tmp → deferred (XDG partiel) ; déplacés : aucun',
    ]);
  });

  test('[xdg] les trois racines définies explicitement (app d’essai complète) : la migration a lieu dans ces racines seulement', () => {
    const b = join(base, `xdgall${n}`);
    const env: NodeJS.ProcessEnv = { PROC_WATCH_NO_RECORDER_SYNC: '1', XDG_CONFIG_HOME: join(b, 'c'), XDG_DATA_HOME: join(b, 'd'), XDG_CACHE_HOME: join(b, 'k') };
    mkdirSync(join(b, 'c/proc-watch'), { recursive: true });
    mkdirSync(join(b, 'd/proc-watch'), { recursive: true });
    const r = migrateEarly(deps({ roots: rootsFrom(env, join(b, 'home')), env, systemctl: fakeCtl().ctl }));
    expect(r.status).toBe('done');
    expect(existsSync(join(b, 'c/computer-watcher'))).toBe(true);
    expect(existsSync(join(b, 'd/computer-watcher'))).toBe(true);
  });

  test('[live] dossier de données utilisé par un processus (cwd), même sous NO_RECORDER_SYNC : échec fermé avec son pid et son nom, rien déplacé sous lui', async () => {
    const L = legacyInstall();
    const rec = spawn('sleep', ['30'], { cwd: L.dataDir, stdio: 'ignore' });
    await started(rec);
    const env = { XDG_RUNTIME_DIR: run, PROC_WATCH_NO_RECORDER_SYNC: '1' };
    // selfPid -1 : le « service » est un enfant du processus de test, qui n'est pas l'app
    const r = migrateEarly(deps({ env, dirUser: (dir) => realDirUser(dir, { selfPid: -1 }) }));
    expect(r.status).toBe('partial');
    expect(r.errors['move-dirs']).toContain(`sleep (pid ${rec.pid})`);
    expect(existsSync(join(L.dataDir, 'metrics.db'))).toBe(true);
    expect(readlinkSync(`/proc/${rec.pid}/cwd`)).toBe(realpathSync(L.dataDir));
    expect(existsSync(P().dataDir)).toBe(false);
  });

  test('[live] fichier de la base ouvert (fd) par un processus : refusé ; le processus lui-même (« l’app ») est exclu', async () => {
    const L = legacyInstall();
    const rec = spawn('sh', ['-c', 'exec 3<"$0"; exec sleep 30', join(L.dataDir, 'metrics.db')], { stdio: 'ignore' });
    await started(rec);
    expect(realDirUser(L.dataDir, { selfPid: -1 })).toEqual({ pid: rec.pid, name: 'sleep' });
    // par défaut, l'app (ici le processus de test) et ses descendants sont exclus
    expect(realDirUser(L.dataDir)).toBeNull();
    expect(realDirUser(L.dataDir, { selfPid: rec.pid! })).toBeNull();
    expect(realDirUser(join(roots.home, 'ailleurs'), { selfPid: -1 })).toBeNull();
  });

  test('[lock] SingletonLock de l’ancien dossier tenu par un Computer Watcher vivant (comm computer-watche) : différé, pid et nom dans le message', async () => {
    const L = legacyInstall();
    const bin = join(roots.home, 'computer-watcher');
    copyFileSync('/usr/bin/sleep', bin);
    chmodSync(bin, 0o755);
    const p = spawn(bin, ['30'], { stdio: 'ignore' });
    await started(p);
    symlinkSync(`${hostname()}-${p.pid}`, join(L.configDir, 'SingletonLock'));
    expect(realLegacyInstance(roots.configHome)).toEqual({ pid: p.pid, name: 'computer-watche' });
    const r = migrateEarly(deps({ legacyInstance: () => realLegacyInstance(roots.configHome) }));
    expect(r.status).toBe('deferred');
    expect(r.detail).toContain(`computer-watche (pid ${p.pid})`);
    expect(existsSync(L.configDir)).toBe(true);
    expect(existsSync(P().configDir)).toBe(false);
  });

  test('[lock] « Réessayer » : la nouvelle instance attend que l’ancien pid ait réellement quitté', async () => {
    const quick = spawn('sleep', ['0.4'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    const block = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    // l'enfant non récolté reste zombie : waitPidGone le tient pour sorti
    expect(waitPidGone({ pid: quick.pid!, sleep: block, maxMs: 5000 })).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    const slow = spawn('sleep', ['30'], { stdio: 'ignore' });
    await started(slow);
    expect(waitPidGone({ pid: slow.pid!, sleep: block, maxMs: 300 })).toBe(false);
  });

  test('M1 : stop qui échoue → service remis dans son état initial (relancé, réactivé), échec fermé', () => {
    const L = legacyInstall();
    mkdirSync(dirname(L.unit), { recursive: true });
    writeFileSync(L.unit, '[Unit]\n');
    const f = fakeCtl({ frag: L.unit, active: 'active', failOn: 'stop' });
    const r = migrateEarly(deps({ systemctl: f.ctl }));
    expect(r.errors['stop-legacy-service']).toMatch(/stop a échoué.*remis/);
    expect(f.calls.map((c) => c[0])).toEqual(['show', 'is-enabled', 'is-active', 'stop', 'start', 'enable']);
    expect(existsSync(L.configDir)).toBe(true);
  });

  test('M1 : disable qui échoue après l’arrêt → relancé et réactivé, échec fermé, rien déplacé', () => {
    const L = legacyInstall();
    mkdirSync(dirname(L.unit), { recursive: true });
    writeFileSync(L.unit, '[Unit]\n');
    const f = fakeCtl({ frag: L.unit, activeSeq: ['active', 'inactive'], failOn: 'disable' });
    const r = migrateEarly(deps({ systemctl: f.ctl }));
    expect(r.errors['stop-legacy-service']).toMatch(/disable a échoué.*remis/);
    expect(f.calls.map((c) => c[0])).toEqual(['show', 'is-enabled', 'is-active', 'stop', 'is-active', 'disable', 'start', 'enable']);
    expect(existsSync(L.configDir)).toBe(true);
  });
});
