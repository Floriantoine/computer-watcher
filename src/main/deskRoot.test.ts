// Script root du bureau prioritaire : exécuté par /usr/bin/bash (JAMAIS pkexec) sur une fausse racine sous ~/.cache/pw-*,
// avec un faux systemctl qui note ses arguments. Gestionnaire : pkexec, confirmation et état simulés.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DESK_ROOT_DROPINS, deskRootContent, deskRootStatus, type DeskRootStatus } from '../core/antigel/deskRoot';
import {
  DESK_ROOT_ARGV0, DESK_ROOT_SCRIPT, createDeskRootAction, deskRootArgv, deskRootConfirmation, deskRootExitMessage, deskRootFake, deskRootScript,
  createDeskRootService, deskRootTargetFrom, hasRecursiveProt, readDeskRootStatus, runDeskRoot,
} from './deskRoot';
import { PKEXEC } from './earlyoom';

let base: string;
let etc: string;
let systemctl: string;
let log: string;
beforeEach(() => {
  mkdirSync(join(homedir(), '.cache'), { recursive: true });
  base = mkdtempSync(join(homedir(), '.cache', 'pw-desk-root-'));
  etc = join(base, 'etc');
  mkdirSync(etc);
  log = join(base, 'systemctl.log');
  systemctl = join(base, 'systemctl');
  writeFileSync(systemctl, `#!/bin/bash\nprintf '%s\\n' "$*" >> '${log}'\n[[ -f '${base}/fail' ]] && exit 1\nexit 0\n`);
  chmodSync(systemctl, 0o755);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const runScript = (...args: string[]) => spawnSync('/usr/bin/bash', ['-c', deskRootScript({ etc, systemctl }), DESK_ROOT_ARGV0, ...args], { encoding: 'utf8' });
const files = () => DESK_ROOT_DROPINS.map((d) => {
  const p = join(etc, d.dir, 'computer-watcher-desk.conf');
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
});
const reloads = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');

describe('script root', () => {
  it('le script réel vise /etc/systemd/system et /usr/bin/systemctl', () => {
    expect(DESK_ROOT_SCRIPT).toContain('etc=/etc/systemd/system\n');
    expect(DESK_ROOT_SCRIPT).toContain('systemctl=/usr/bin/systemctl\n');
    expect(deskRootArgv('install', 4771)).toEqual(['/usr/bin/bash', '-c', DESK_ROOT_SCRIPT, 'computer-watcher-desk', 'install', '4771']);
    expect(deskRootArgv('remove', null)).toEqual(['/usr/bin/bash', '-c', DESK_ROOT_SCRIPT, 'computer-watcher-desk', 'remove', '0']);
    expect(() => deskRootArgv('install', 12)).toThrow();
    expect(() => deskRootArgv('other' as 'install', 4771)).toThrow();
  });
  it('chemins non conformes refusés à la construction', () => {
    expect(() => deskRootScript({ etc: '/etc/x y', systemctl })).toThrow();
    expect(() => deskRootScript({ etc, systemctl: 'systemctl' })).toThrow();
    expect(() => deskRootScript({ etc: "/etc/$(id)", systemctl })).toThrow();
  });
  it('installe les trois fichiers, au contenu exact du générateur, puis daemon-reload', () => {
    const r = runScript('install', '4771');
    expect(r.status).toBe(0);
    expect(files()).toEqual(DESK_ROOT_DROPINS.map((d) => deskRootContent(d.section, 4771)));
    for (const d of DESK_ROOT_DROPINS) expect(statSync(join(etc, d.dir, 'computer-watcher-desk.conf')).mode & 0o777).toBe(0o644);
    expect(reloads()).toBe('daemon-reload\n');
    // mise à jour : remplacés, aucun fichier temporaire laissé
    expect(runScript('install', '8192').status).toBe(0);
    expect(files()).toEqual(DESK_ROOT_DROPINS.map((d) => deskRootContent(d.section, 8192)));
    expect(execFileSync('/usr/bin/find', [etc, '-name', '*.tmp'], { encoding: 'utf8' })).toBe('');
  });
  it('retire les fichiers et les dossiers vides, puis daemon-reload', () => {
    runScript('install', '4771');
    writeFileSync(join(etc, 'user@.service.d', 'autre.conf'), '[Service]\n');
    const r = runScript('remove', '0');
    expect(r.status).toBe(0);
    expect(files()).toEqual([null, null, null]);
    expect(existsSync(join(etc, 'user.slice.d'))).toBe(false);
    expect(existsSync(join(etc, 'user@.service.d', 'autre.conf'))).toBe(true); // jamais un autre fichier
    expect(reloads()).toBe('daemon-reload\ndaemon-reload\n');
  });
  it.each([
    [[], 64], [['install'], 64], [['install', '4771', 'x'], 64], [['purge', '4771'], 64], [['remove', '12'], 64],
    [['install', '255'], 65], [['install', '1048577'], 65], [['install', '04771'], 65], [['install', '4771M'], 65], [['install', '1;id'], 65], [['install', ''], 65],
  ])('arguments %j refusés (code %i), rien d’écrit ni rechargé', (args, code) => {
    expect(runScript(...(args as string[])).status).toBe(code);
    expect(files()).toEqual([null, null, null]);
    expect(reloads()).toBe('');
  });
  it('systemctl absent : 67', () => {
    rmSync(systemctl);
    expect(runScript('install', '4771').status).toBe(67);
    expect(files()).toEqual([null, null, null]);
  });
  it('dossier en lien symbolique : 66, rien écrit à travers', () => {
    const other = join(base, 'ailleurs');
    mkdirSync(other);
    symlinkSync(other, join(etc, 'user-.slice.d'));
    expect(runScript('install', '4771').status).toBe(66);
    expect(existsSync(join(other, 'computer-watcher-desk.conf'))).toBe(false);
    expect(files()[0]).toBeNull();
    expect(reloads()).toBe('');
  });
  it('daemon-reload en échec : 68', () => {
    writeFileSync(join(base, 'fail'), '');
    expect(runScript('install', '4771').status).toBe(68);
  });
});

describe('deskRootExitMessage', () => {
  it('codes connus', () => {
    expect(deskRootExitMessage(0, 'install', '')).toMatchObject({ ok: true });
    expect(deskRootExitMessage(126, 'install', '')).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(deskRootExitMessage(127, 'install', '')).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(deskRootExitMessage(127, 'install', 'bash: not found')).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(deskRootExitMessage(65, 'install', '').message).toMatch(/rien n’a été modifié/);
    expect(deskRootExitMessage(68, 'remove', '').message).toMatch(/daemon-reload/);
    expect(deskRootExitMessage(99, 'install', 'x\u001b[31m oups').message).toMatch(/code 99/);
  });
});

describe('runDeskRoot', () => {
  it('pkexec du script figé, argv exact', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const r = await runDeskRoot('install', 4771, async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stderr: '' };
    });
    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ cmd: PKEXEC, args: deskRootArgv('install', 4771) }]);
  });
  it('pkexec introuvable', async () => {
    const r = await runDeskRoot('remove', null, async () => {
      throw Object.assign(new Error('x'), { code: 'ENOENT' });
    });
    expect(r).toMatchObject({ ok: false, reason: 'unavailable' });
  });
});

describe('readDeskRootStatus', () => {
  it('fichiers, memory.low des trois niveaux, memory_recursiveprot', () => {
    runScript('install', '4771');
    const cg = join(base, 'cgroup');
    for (const [p, v] of [['user.slice', '5002756096'], ['user.slice/user-1000.slice', '5002756096'], ['user.slice/user-1000.slice/user@1000.service', 'max']]) {
      mkdirSync(join(cg, p), { recursive: true });
      writeFileSync(join(cg, p, 'memory.low'), `${v}\n`);
    }
    const mounts = 'cgroup2 /sys/fs/cgroup cgroup2 rw,nosuid,nodev,noexec,relatime,nsdelegate,memory_recursiveprot 0 0\n';
    const s = readDeskRootStatus({ etc, cgroupRoot: cg, uid: 1000, targetMB: 4771, mounts });
    expect(s).toMatchObject({ files: 'installed', installedMB: 4771, effective: true, recursiveprot: true });
    expect(s.levels.map((l) => l.low)).toEqual([5002756096, 5002756096, Infinity]);
    expect(s.paths[0]).toBe(join(etc, 'user.slice.d', 'computer-watcher-desk.conf'));
    const none = readDeskRootStatus({ etc: join(base, 'vide'), cgroupRoot: join(base, 'vide'), uid: 1000, targetMB: null, mounts: null });
    expect(none).toMatchObject({ files: 'absent', effective: false, recursiveprot: false });
    expect(none.levels.map((l) => l.low)).toEqual([null, null, null]);
  });
});

describe('deskRootTargetFrom', () => {
  it('réserve automatique (max 4 Go, 15 % de la RAM) ou réglée', () => {
    expect(deskRootTargetFrom(null, 32564348)).toBe(4771);
    expect(deskRootTargetFrom(6144, 32564348)).toBe(6144);
    expect(deskRootTargetFrom(null, 0)).toBeNull();
    // réserve qui ne laisse pas 1 Go au travail : plafond de travail impossible, rien à poser
    expect(deskRootTargetFrom(32000, 32564348)).toBeNull();
  });
  it('memory_recursiveprot lu dans /proc/mounts', () => {
    expect(hasRecursiveProt('cgroup2 /sys/fs/cgroup cgroup2 rw,memory_recursiveprot,nsdelegate 0 0')).toBe(true);
    expect(hasRecursiveProt('cgroup2 /sys/fs/cgroup cgroup2 rw,nsdelegate 0 0')).toBe(false);
    expect(hasRecursiveProt('x /autre cgroup2 rw,memory_recursiveprot 0 0')).toBe(false);
  });
});

describe('deskRootConfirmation', () => {
  it('installation : les trois fichiers, leur contenu exact, la commande', () => {
    const st = deskRootStatus({ files: [null, null, null], lows: [0, 0, 0], targetMB: 4771, uid: 1000, recursiveprot: true });
    const c = deskRootConfirmation('install', st);
    for (const p of st.paths) expect(c.detail).toContain(p);
    expect(c.detail).toContain('MemoryLow=4771M');
    expect(c.detail).toContain('[Service]');
    expect(c.detail).toContain('systemctl daemon-reload');
    expect(c.detail).toContain('pkexec /usr/bin/bash -c … computer-watcher-desk install 4771');
    expect(c.confirm).toBe('Activer');
  });
  it('retrait', () => {
    const st = deskRootStatus({ files: DESK_ROOT_DROPINS.map((d) => deskRootContent(d.section, 4771)), lows: [1, 1, 1], targetMB: 4771, uid: 1000, recursiveprot: true });
    const c = deskRootConfirmation('remove', st);
    expect(c.detail).toContain('computer-watcher-desk remove');
    expect(c.confirm).toBe('Retirer');
  });
});

describe('createDeskRootAction', () => {
  const mk = (mb: number | null, lows: number[] = [0, 0, 0], target: number | null = 4771): DeskRootStatus =>
    deskRootStatus({ files: DESK_ROOT_DROPINS.map((d) => (mb === null ? null : deskRootContent(d.section, mb))), lows, targetMB: target, uid: 1000, recursiveprot: true });
  const setup = (states: DeskRootStatus[], answer = true, code = 0) => {
    const calls: string[][] = [];
    const confirms: string[] = [];
    let k = 0;
    const action = createDeskRootAction({
      status: async () => states[Math.min(k++, states.length - 1)]!,
      confirm: async (c) => {
        confirms.push(c.detail);
        return answer;
      },
      run: async (_cmd, args) => {
        calls.push(args.slice(3));
        return { code, stderr: '' };
      },
    });
    return { action, calls, confirms };
  };
  it('mode inconnu : refusé sans rien lancer', async () => {
    const s = setup([mk(null)]);
    expect(await s.action('purge')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(s.calls).toEqual([]);
  });
  it('activer : confirmation, relecture, pkexec, puis effet vérifié', async () => {
    const s = setup([mk(null), mk(null), mk(4771, [1, 1, 1])]);
    const r = await s.action('install');
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/active/);
    expect(r.status?.effective).toBe(true);
    expect(s.calls).toEqual([['computer-watcher-desk', 'install', '4771']]);
    expect(s.confirms).toHaveLength(1);
  });
  it('activer, mais memory.low reste à 0 : dit, sans prétendre l’effet', async () => {
    const s = setup([mk(null), mk(null), mk(4771)]);
    const r = await s.action('install');
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/reste à 0/);
  });
  it('annulé : rien lancé', async () => {
    const s = setup([mk(null)], false);
    expect(await s.action('install')).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(s.calls).toEqual([]);
  });
  it('état changé pendant la confirmation : rien lancé', async () => {
    const s = setup([mk(null), mk(4771)]);
    expect(await s.action('install')).toMatchObject({ ok: false, reason: 'stale' });
    expect(s.calls).toEqual([]);
  });
  it('déjà installé : rien à faire ; réserve inconnue : refus', async () => {
    expect(await setup([mk(4771)]).action('install')).toMatchObject({ ok: false, reason: 'stale' });
    expect(await setup([mk(null, [0, 0, 0], null)]).action('install')).toMatchObject({ ok: false, reason: 'unavailable' });
  });
  it('obsolète : mise à jour à la nouvelle valeur', async () => {
    const s = setup([mk(4096), mk(4096), mk(4771, [1, 1, 1])]);
    expect((await s.action('install')).ok).toBe(true);
    expect(s.calls).toEqual([['computer-watcher-desk', 'install', '4771']]);
  });
  it('retirer', async () => {
    const s = setup([mk(4771, [1, 1, 1]), mk(4771, [1, 1, 1]), mk(null)]);
    const r = await s.action('remove');
    expect(r).toMatchObject({ ok: true });
    expect(s.calls).toEqual([['computer-watcher-desk', 'remove', '0']]);
    expect(await setup([mk(null)]).action('remove')).toMatchObject({ ok: false, reason: 'stale' });
  });
  it('échec du script : message, pas de succès', async () => {
    const s = setup([mk(null), mk(null)], true, 66);
    expect(await s.action('install')).toMatchObject({ ok: false, reason: 'failed' });
  });
  it('un seul à la fois', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const action = createDeskRootAction({
      status: async () => mk(null),
      confirm: async () => {
        await gate;
        return false;
      },
      run: async () => ({ code: 0, stderr: '' }),
    });
    const first = action('install');
    expect(await action('install')).toMatchObject({ ok: false, reason: 'failed' });
    release();
    expect(await first).toMatchObject({ reason: 'cancelled' });
  });
});

describe('deskRootFake', () => {
  it('ignoré dans une app empaquetée, sans variable, chemin relatif ou sous /etc', () => {
    expect(deskRootFake({ PROC_WATCH_DESK_ROOT_FAKE: base }, true)).toBeNull();
    expect(deskRootFake({}, false)).toBeNull();
    expect(deskRootFake({ PROC_WATCH_DESK_ROOT_FAKE: 'rel' }, false)).toBeNull();
    expect(deskRootFake({ PROC_WATCH_DESK_ROOT_FAKE: '/etc' }, false)).toBeNull();
  });
  it('exécute le vrai script avec bash (sans pkexec) sur <dossier>/etc et <dossier>/systemctl', async () => {
    const f = deskRootFake({ PROC_WATCH_DESK_ROOT_FAKE: base }, false)!;
    expect(f.etc).toBe(etc);
    expect(f.cgroupRoot).toBe(join(base, 'cgroup'));
    const r = await runDeskRoot('install', 4771, f.run);
    expect(r.ok).toBe(true);
    expect(files()).toEqual(DESK_ROOT_DROPINS.map((d) => deskRootContent(d.section, 4771)));
    expect(reloads()).toBe('daemon-reload\n');
  });
});

describe('createDeskRootService (simulé)', () => {
  it('état lu sous le dossier simulé, activation puis retrait par le vrai script', async () => {
    writeFileSync(join(base, 'mounts'), 'cgroup2 /sys/fs/cgroup cgroup2 rw,memory_recursiveprot 0 0\n');
    const confirms: string[] = [];
    const svc = createDeskRootService({
      env: { PROC_WATCH_DESK_ROOT_FAKE: base }, isPackaged: false, uid: 1000, reserveMB: () => null, memTotalKB: () => 32564348,
      confirm: async (c) => {
        confirms.push(c.detail);
        return true;
      },
    });
    expect(svc.fake).toBe(true);
    const before = await svc.status();
    expect(before).toMatchObject({ files: 'absent', targetMB: 4771, recursiveprot: true, fake: true, effective: false });
    const r = await svc.apply('install');
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/reste à 0/); // le faux systemctl ne touche pas au faux sysfs
    expect(svc.read()).toMatchObject({ files: 'installed', installedMB: 4771 });
    expect(confirms[0]).toContain(join(etc, 'user@.service.d', 'computer-watcher-desk.conf'));
    expect((await svc.apply('remove')).ok).toBe(true);
    expect(svc.read().files).toBe('absent');
  });
});
