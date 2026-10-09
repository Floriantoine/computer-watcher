import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import type { FamilyId, FamilyRoots } from '../core/disk/families';
import { cleanFamilies, diskCleanEvent, realProcByName, staticRefusal, type CleanDeps } from './diskClean';

// HOME et XDG temporaires sous ~/.cache/pw-disk-* (même disque que le dossier personnel, jamais les vrais caches)
mkdirSync(join(homedir(), '.cache'), { recursive: true });
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function fakeHome() {
  const base = realpathSync(mkdtempSync(join(homedir(), '.cache', 'pw-disk-clean-')));
  made.push(base);
  const home = join(base, 'home');
  const roots: FamilyRoots = { home, configHome: join(home, '.config'), dataHome: join(home, '.local/share'), cacheHome: join(home, '.cache') };
  const fill = (p: string, kb = 4) => {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, Buffer.alloc(kb * 1024, 1));
  };
  fill(join(home, '.npm/_cacache/content-v2/sha512/ab/cd'));
  fill(join(home, '.npm/_logs/garde.log')); // voisin : jamais touché
  fill(join(home, '.cache/uv/wheels/x.whl'));
  fill(join(home, '.cache/voisin/garde'));
  for (const v of ['chromium-1140', 'chromium-1155', 'firefox-1466']) fill(join(home, '.cache/ms-playwright', v, 'bin'));
  fill(join(home, '.cache/ms-playwright/.links/l'));
  fill(join(home, '.local/share/Trash/files/vieux.txt'));
  mkdirSync(join(home, '.local/share/Trash/files/dossier/sous'), { recursive: true });
  fill(join(home, '.local/share/Trash/info/vieux.txt.trashinfo'));
  const precious = join(base, 'precieux');
  fill(join(precious, 'these.odt'));
  return { base, home, roots, precious };
}

/** Dépendances neutres : confirmation acceptée, personne n'utilise rien, statfs qui « libère » 1000 Ko par appel. */
function deps(roots: FamilyRoots, o: Partial<CleanDeps> = {}) {
  let avail = 5000;
  const asked: { message: string; detail: string }[] = [];
  const d: CleanDeps = {
    roots,
    confirm: async (s) => {
      asked.push(s);
      return true;
    },
    dirUser: () => null,
    procByName: () => null,
    statfs: () => ({ availKB: (avail += 1000) }),
    runRoot: async () => ({ ok: true, cancelled: false }),
    mountinfo: () => '',
    sizes: { npm: 8 * 1024 * 1024, uv: 1024 },
    rootUnavailable: () => null,
    ...o,
  };
  return { d, asked };
}

describe('cleanFamilies', () => {
  test('npm et uv : arbres supprimés, voisins intacts, freedKB = différence statfs, confirmation récapitulative', async () => {
    const { home, roots } = fakeHome();
    const { d, asked } = deps(roots);
    const r = await cleanFamilies(['npm', 'uv'], d);
    expect(r).toEqual({ freedKB: 1000, estimatedKB: 8 * 1024 * 1024 + 1024, done: ['npm', 'uv'], refused: [], cancelled: false });
    expect(existsSync(join(home, '.npm/_cacache'))).toBe(false);
    expect(existsSync(join(home, '.cache/uv'))).toBe(false);
    expect(existsSync(join(home, '.npm/_logs/garde.log'))).toBe(true);
    expect(existsSync(join(home, '.cache/voisin/garde'))).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0].message).toMatch(/Libérer/);
    expect(asked[0].detail).toMatch(/Cache npm[^\n]*8,0 Go/);
    expect(asked[0].detail).toMatch(/Cache uv[^\n]*1 Mo/);
    expect(asked[0].detail).toMatch(/définitif/i);
  });

  test('cache remplacé par un lien vers un dossier précieux : refus « lien symbolique », rien hors du cache supprimé', async () => {
    const { home, roots, precious } = fakeHome();
    rmSync(join(home, '.cache/uv'), { recursive: true });
    symlinkSync(precious, join(home, '.cache/uv'));
    const { d } = deps(roots);
    const r = await cleanFamilies(['uv', 'npm'], d);
    expect(r.refused).toEqual([{ id: 'uv', reason: '~/.cache/uv : lien symbolique, refusé (jamais suivi)' }]);
    expect(r.done).toEqual(['npm']);
    expect(readdirSync(precious)).toEqual(['these.odt']);
    expect(existsSync(join(home, '.cache/uv'))).toBe(true); // le lien lui-même reste
  });

  test('cache utilisé (npm en cours) : refus avec nom et pid, rien supprimé, pas de confirmation', async () => {
    const { home, roots } = fakeHome();
    const npmDir = join(home, '.npm/_cacache');
    const { d, asked } = deps(roots, { dirUser: (dir) => (dir === npmDir ? { pid: 4242, name: 'npm' } : null) });
    const r = await cleanFamilies(['npm'], d);
    expect(r).toEqual({ freedKB: 0, done: [], refused: [{ id: 'npm', reason: 'utilisé par npm (pid 4242)' }], cancelled: false });
    expect(existsSync(npmDir)).toBe(true);
    expect(asked).toHaveLength(0);
  });

  test('outil de la famille en cours (par nom) : refus', async () => {
    const { home, roots } = fakeHome();
    const { d } = deps(roots, { procByName: (names) => (names.includes('uv') ? { pid: 77, name: 'uv' } : null) });
    const r = await cleanFamilies(['uv'], d);
    expect(r.refused).toEqual([{ id: 'uv', reason: 'utilisé par uv (pid 77)' }]);
    expect(existsSync(join(home, '.cache/uv'))).toBe(true);
  });

  test('utilisé juste après la confirmation (revérification) : refus, rien supprimé', async () => {
    const { home, roots } = fakeHome();
    let confirmed = false;
    const { d } = deps(roots, {
      confirm: async () => (confirmed = true),
      dirUser: () => (confirmed ? { pid: 9, name: 'node' } : null),
    });
    const r = await cleanFamilies(['npm'], d);
    expect(r.refused).toEqual([{ id: 'npm', reason: 'utilisé par node (pid 9)' }]);
    expect(existsSync(join(home, '.npm/_cacache'))).toBe(true);
  });

  test('point de montage sous un cache (mountinfo) : refus, rien supprimé', async () => {
    const { home, roots } = fakeHome();
    const mi = `1 2 0:99 / ${join(home, '.cache/uv/wheels')} rw - tmpfs t rw\n`;
    const { d } = deps(roots, { mountinfo: () => mi });
    const r = await cleanFamilies(['uv'], d);
    expect(r.refused).toEqual([{ id: 'uv', reason: expect.stringMatching(/point de montage/) }]);
    expect(existsSync(join(home, '.cache/uv/wheels/x.whl'))).toBe(true);
  });

  test('confirmation refusée : cancelled, rien supprimé', async () => {
    const { home, roots } = fakeHome();
    const { d } = deps(roots, { confirm: async () => false });
    const r = await cleanFamilies(['npm', 'uv'], d);
    expect(r).toEqual({ freedKB: 0, done: [], refused: [], cancelled: true });
    expect(existsSync(join(home, '.npm/_cacache'))).toBe(true);
    expect(existsSync(join(home, '.cache/uv'))).toBe(true);
  });

  test('navigateurs de test : seules les anciennes versions supprimées', async () => {
    const { home, roots } = fakeHome();
    const r = await cleanFamilies(['test-browsers'], deps(roots).d);
    expect(r.done).toEqual(['test-browsers']);
    expect(readdirSync(join(home, '.cache/ms-playwright')).sort()).toEqual(['.links', 'chromium-1155', 'firefox-1466']);
  });

  test('corbeille : contenu de files et info supprimé, dossiers gardés', async () => {
    const { home, roots } = fakeHome();
    const r = await cleanFamilies(['trash'], deps(roots).d);
    expect(r.done).toEqual(['trash']);
    expect(readdirSync(join(home, '.local/share/Trash/files'))).toEqual([]);
    expect(readdirSync(join(home, '.local/share/Trash/info'))).toEqual([]);
  });

  test('famille absente : refus « introuvable », sans confirmation', async () => {
    const { roots } = fakeHome();
    const { d, asked } = deps(roots);
    const r = await cleanFamilies(['cargo'], d);
    expect(r.refused).toEqual([{ id: 'cargo', reason: 'introuvable' }]);
    expect(asked).toHaveLength(0);
  });

  test('ids inconnus ou dupliqués : rejetés avant toute action', async () => {
    const { home, roots } = fakeHome();
    const { d, asked } = deps(roots);
    await expect(cleanFamilies(['npm', 'npm'] as FamilyId[], d)).rejects.toThrow(/refusée/);
    await expect(cleanFamilies(['npm', '../x'] as unknown as FamilyId[], d)).rejects.toThrow(/refusée/);
    expect(asked).toHaveLength(0);
    expect(existsSync(join(home, '.npm/_cacache'))).toBe(true);
  });

  test('root : runRoot appelé avec l’action seule ; annulation pkexec = « annulé », pas une erreur', async () => {
    const { roots } = fakeHome();
    const calls: string[] = [];
    const { d } = deps(roots, {
      runRoot: async (a) => {
        calls.push(a);
        return a === 'journal' ? { ok: false, cancelled: true } : { ok: true, cancelled: false };
      },
      rootPresent: () => true,
    });
    const r = await cleanFamilies(['pkg-cache', 'journal'], d);
    expect(calls).toEqual(['pkg-cache', 'journal']);
    expect(r.done).toEqual(['pkg-cache']);
    expect(r.refused).toEqual([{ id: 'journal', reason: 'annulé' }]);
  });

  test('root : gestionnaire de paquets en cours → refus, pkexec jamais lancé', async () => {
    const { roots } = fakeHome();
    const calls: string[] = [];
    const { d } = deps(roots, {
      runRoot: async (a) => (calls.push(a), { ok: true, cancelled: false }),
      rootPresent: () => true,
      procByName: (names) => (names.includes('pacman') ? { pid: 5, name: 'pacman' } : null),
    });
    const r = await cleanFamilies(['pkg-cache'], d);
    expect(r.refused).toEqual([{ id: 'pkg-cache', reason: 'utilisé par pacman (pid 5)' }]);
    expect(calls).toEqual([]);
  });
});

test('événement disk_clean : libéré, familles, refus (rien si aucune action)', () => {
  expect(diskCleanEvent({ freedKB: 10, done: ['npm'], refused: [{ id: 'uv', reason: 'x' }], cancelled: false }, 5)).toEqual({
    ts: 5, type: 'disk_clean', groupKey: null, detail: { freedKB: 10, done: ['npm'], refused: [{ id: 'uv', reason: 'x' }] },
  });
  expect(diskCleanEvent({ freedKB: 0, done: [], refused: [], cancelled: true }, 5)).toBeNull();
});

test('realProcByName : par nom (comm), utilisateur courant seulement, jamais l’app ni ses descendants', () => {
  const base = realpathSync(mkdtempSync(join(homedir(), '.cache', 'pw-disk-proc-')));
  made.push(base);
  const proc = (pid: number, ppid: number, comm: string) => {
    mkdirSync(join(base, String(pid)));
    writeFileSync(join(base, String(pid), 'stat'), `${pid} (${comm}) S ${ppid} 0 0`);
    writeFileSync(join(base, String(pid), 'comm'), `${comm}\n`);
  };
  proc(100, 1, 'computer-watche');
  proc(101, 100, 'npm'); // descendant de l'app : ignoré
  proc(200, 1, 'bash');
  proc(201, 200, 'npm');
  expect(realProcByName(['npm', 'npx'], { procRoot: base, selfPid: 100, uid: process.getuid!() })).toEqual({ pid: 201, name: 'npm' });
  expect(realProcByName(['cargo'], { procRoot: base, selfPid: 100, uid: process.getuid!() })).toBeNull();
  expect(realProcByName(['npm'], { procRoot: base, selfPid: 100, uid: process.getuid!() + 1 })).toBeNull();
});

test('staticRefusal : lien symbolique visible dans la liste, sans parcourir les processus', () => {
  const { home, roots, precious } = fakeHome();
  rmSync(join(home, '.cache/uv'), { recursive: true });
  symlinkSync(precious, join(home, '.cache/uv'));
  expect(staticRefusal('uv', { roots, mountinfo: () => '' })).toMatch(/lien symbolique/);
  expect(staticRefusal('npm', { roots, mountinfo: () => '' })).toBeNull();
});

test('root indisponible (pacman sans paccache) : refus avec la raison, pkexec jamais lancé', async () => {
  const { roots } = fakeHome();
  const calls: string[] = [];
  const { d, asked } = deps(roots, {
    runRoot: async (a) => (calls.push(a), { ok: true, cancelled: false }),
    rootPresent: () => true,
    rootUnavailable: (id) => (id === 'pkg-cache' ? 'indisponible : installer pacman-contrib (paccache)' : null),
  });
  const r = await cleanFamilies(['pkg-cache'], d);
  expect(r.refused).toEqual([{ id: 'pkg-cache', reason: 'indisponible : installer pacman-contrib (paccache)' }]);
  expect(calls).toEqual([]);
  expect(asked).toHaveLength(0);
});
