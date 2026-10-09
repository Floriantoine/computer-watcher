import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { DISK_ROOT_SCRIPT, diskRootArgv, diskRootRunner, diskRootScript, rootUnavailable, runDiskRoot } from './diskRoot';

mkdirSync(join(homedir(), '.cache'), { recursive: true });
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

test('argv figé : pkexec n’est jamais dans l’argv, bash par chemin absolu, l’action seule en argument', () => {
  expect(diskRootArgv('pkg-cache')).toEqual(['/usr/bin/bash', '-c', DISK_ROOT_SCRIPT, 'computer-watcher-disk', 'pkg-cache']);
  expect(diskRootArgv('journal')).toEqual(['/usr/bin/bash', '-c', DISK_ROOT_SCRIPT, 'computer-watcher-disk', 'journal']);
  // le script ne lit aucune variable d'environnement autre que celles qu'il fixe, et n'utilise que des chemins absolus
  expect(DISK_ROOT_SCRIPT).toContain('export PATH=/usr/bin:/bin');
  expect(DISK_ROOT_SCRIPT).toContain('/usr/bin/paccache');
  expect(DISK_ROOT_SCRIPT).toContain('/usr/bin/journalctl');
  expect(DISK_ROOT_SCRIPT).not.toMatch(/\$\{?(HOME|USER|XDG_|DISPLAY)/);
  expect(DISK_ROOT_SCRIPT).not.toMatch(/(^|[^.])\bsource\b|^\s*\. /m);
});

test('bash -n : script valide', () => {
  const r = spawnSync('/usr/bin/bash', ['-n', '-c', DISK_ROOT_SCRIPT]);
  expect(r.status).toBe(0);
});

describe('runDiskRoot (pkexec simulé)', () => {
  const runWith = (code: number, stderr = '') => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { code, stderr };
    };
    return { calls, run };
  };
  test('succès : pkexec /usr/bin/bash -c SCRIPT computer-watcher-disk <action>', async () => {
    const { calls, run } = runWith(0);
    expect(await runDiskRoot('journal', run)).toEqual({ ok: true, cancelled: false });
    expect(calls).toEqual([{ cmd: '/usr/bin/pkexec', args: diskRootArgv('journal') }]);
  });
  test.each([126, 127])('pkexec %i (authentification annulée ou refusée) : annulé, pas une erreur', async (code) => {
    expect(await runDiskRoot('pkg-cache', runWith(code, 'Error executing command as another user: Not authorized').run)).toEqual({ ok: false, cancelled: true });
    expect(await runDiskRoot('pkg-cache', runWith(code).run)).toEqual({ ok: false, cancelled: true });
  });
  test('revue m-3 : outil introuvable dans le script → 67 « outil introuvable », jamais « annulé »', async () => {
    expect(await runDiskRoot('journal', runWith(67, '/usr/bin/env').run)).toEqual({ ok: false, cancelled: false, error: expect.stringMatching(/outil introuvable/) });
    // 127 avec un message « not found » (commande introuvable) : pas un refus d'authentification
    expect(await runDiskRoot('journal', runWith(127, 'env: not found').run)).toEqual({ ok: false, cancelled: false, error: expect.stringMatching(/introuvable/) });
  });
  test('65 : installer pacman-contrib ; 66 : distribution non prise en charge ; autre : code et dernier message', async () => {
    expect(await runDiskRoot('pkg-cache', runWith(65).run)).toEqual({ ok: false, cancelled: false, error: expect.stringMatching(/installer pacman-contrib/) });
    expect(await runDiskRoot('pkg-cache', runWith(66).run)).toEqual({ ok: false, cancelled: false, error: expect.stringMatching(/distribution non prise en charge/) });
    expect(await runDiskRoot('journal', runWith(1, 'a\nverrou occupé\n').run)).toEqual({ ok: false, cancelled: false, error: expect.stringMatching(/code 1.*verrou occupé/) });
  });
  test('action inconnue (impossible à typer) : refusée sans rien lancer', async () => {
    const { calls, run } = runWith(0);
    expect(await runDiskRoot('rm -rf /' as never, run)).toEqual({ ok: false, cancelled: false, error: expect.stringMatching(/refusée/) });
    expect(calls).toEqual([]);
  });
});

describe('script exécuté sans root dans un faux système (chemins des outils remplacés)', () => {
  function fakeSystem(o: { paccache?: boolean; pacman?: boolean; aptGet?: boolean; osRelease?: string }) {
    const base = realpathSync(mkdtempSync(join(homedir(), '.cache', 'pw-disk-root-')));
    made.push(base);
    const log = join(base, 'appels.log');
    const tool = (name: string) => {
      const p = join(base, name);
      writeFileSync(p, `#!/usr/bin/bash\necho "${name} $*" >> ${JSON.stringify(log)}\n`);
      chmodSync(p, 0o755);
      return p;
    };
    const bins = {
      paccache: o.paccache ? tool('paccache') : join(base, 'absent-paccache'),
      pacman: o.pacman ? tool('pacman') : join(base, 'absent-pacman'),
      aptGet: o.aptGet ? tool('apt-get') : join(base, 'absent-apt-get'),
      journalctl: tool('journalctl'),
      osRelease: join(base, 'os-release'),
    };
    if (o.osRelease !== undefined) writeFileSync(bins.osRelease, o.osRelease);
    const run = (action: string) => {
      const r = spawnSync('/usr/bin/bash', ['-c', diskRootScript(bins), 'computer-watcher-disk', action], { encoding: 'utf8', env: {} });
      return { code: r.status, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
    };
    return { run, bins };
  }
  test('Arch avec paccache : paccache -rk2', () => {
    expect(fakeSystem({ paccache: true, pacman: true, osRelease: 'ID=arch\n' }).run('pkg-cache')).toEqual({ code: 0, calls: ['paccache -rk2'] });
  });
  test('Manjaro (ID_LIKE=arch) sans paccache : 65, rien lancé', () => {
    expect(fakeSystem({ pacman: true, osRelease: 'ID=manjaro\nID_LIKE=arch\n' }).run('pkg-cache')).toEqual({ code: 65, calls: [] });
  });
  test('Debian : apt-get clean', () => {
    expect(fakeSystem({ aptGet: true, osRelease: 'ID=debian\n' }).run('pkg-cache')).toEqual({ code: 0, calls: ['apt-get clean'] });
  });
  test('distribution non reconnue sans gestionnaire : 66', () => {
    expect(fakeSystem({ osRelease: 'ID=autre\n' }).run('pkg-cache')).toEqual({ code: 66, calls: [] });
  });
  test('pacman et apt-get présents, os-release qui désigne Debian : apt-get', () => {
    expect(fakeSystem({ paccache: true, pacman: true, aptGet: true, osRelease: 'ID="ubuntu"\nID_LIKE=debian\n' }).run('pkg-cache')).toEqual({ code: 0, calls: ['apt-get clean'] });
  });
  test('revue m-3 : journalctl absent → 67, rien lancé (jamais 127)', () => {
    const s = fakeSystem({});
    const bins = s.bins;
    rmSync(bins.journalctl);
    expect(s.run('journal')).toEqual({ code: 67, calls: [] });
  });
  test('journal : journalctl --vacuum-size=500M', () => {
    expect(fakeSystem({}).run('journal')).toEqual({ code: 0, calls: ['journalctl --vacuum-size=500M'] });
  });
  test('action inconnue ou arguments en trop : 64, rien lancé', () => {
    const s = fakeSystem({ paccache: true, pacman: true, osRelease: 'ID=arch\n' });
    expect(s.run('tout')).toEqual({ code: 64, calls: [] });
    const r = spawnSync('/usr/bin/bash', ['-c', DISK_ROOT_SCRIPT, 'computer-watcher-disk', 'journal', 'en-trop'], { encoding: 'utf8', env: {} });
    expect(r.status).toBe(64);
  });
});

test('pkexec simulé (PROC_WATCH_DISK_ROOT_FAKE=1) : seulement hors paquet, rien n’est lancé', async () => {
  const fake = diskRootRunner({ PROC_WATCH_DISK_ROOT_FAKE: '1' }, false);
  expect(fake.fake).toBe(true);
  expect(await runDiskRoot('pkg-cache', fake.run)).toEqual({ ok: true, cancelled: false });
  expect(diskRootRunner({ PROC_WATCH_DISK_ROOT_FAKE: '1' }, true).fake).toBe(false);
  expect(diskRootRunner({}, false).fake).toBe(false);
});

test('famille root indisponible : pacman sans paccache → « installer pacman-contrib »', () => {
  const has = (set: string[]) => (p: string) => set.includes(p);
  expect(rootUnavailable('pkg-cache', has(['/usr/bin/pacman']))).toMatch(/installer pacman-contrib/);
  expect(rootUnavailable('pkg-cache', has(['/usr/bin/pacman', '/usr/bin/paccache']))).toBeNull();
  expect(rootUnavailable('pkg-cache', has(['/usr/bin/apt-get']))).toBeNull();
  expect(rootUnavailable('pkg-cache', has([]))).toMatch(/non prise en charge/);
  expect(rootUnavailable('journal', has(['/usr/bin/journalctl']))).toBeNull();
  expect(rootUnavailable('journal', has([]))).toMatch(/journalctl/);
  void execFileSync;
});
