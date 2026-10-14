import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import type { FamilyRoots } from '../core/disk/families';
import { checkCacheDir, listCacheDirs, removeCacheDir } from './diskCacheDirs';
import { removeTreeSafe } from './safeFs';

mkdirSync(join(homedir(), '.cache'), { recursive: true });
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function fakeHome() {
  const base = realpathSync(mkdtempSync(join(homedir(), '.cache', 'pw-disk2-cache-')));
  made.push(base);
  const home = join(base, 'home');
  const roots: FamilyRoots = { home, configHome: join(home, '.config'), dataHome: join(home, '.local/share'), cacheHome: join(home, '.cache') };
  const put = (p: string, kb = 4) => {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, Buffer.alloc(kb * 1024, 1));
  };
  put(join(home, '.cache/uv/CACHEDIR.TAG'), 1);
  put(join(home, '.cache/google-chrome/Default/x'));
  put(join(home, '.cache/computer-watcher-updater/latest.yml'));
  put(join(home, '.cache/outil-inconnu/blob'), 64);
  put(join(home, '.cache/outil-inconnu/app.asar'), 4); // archive Electron : un fichier comme un autre
  put(join(home, '.cache/vignettes/a.png'), 8);
  put(join(home, '.cache/fichier-seul.txt'));
  put(join(home, '.cache/paquet.asar/x'), 1); // dossier nommé *.asar : Electron le lirait comme une archive
  put(join(base, 'precieux/these.odt'));
  symlinkSync(join(base, 'precieux'), join(home, '.cache/lien-precieux'));
  const du = async (paths: string[]) => new Map(paths.map((p) => [p, p.endsWith('outil-inconnu') ? 68 : 8]));
  return { base, home, roots, du };
}

describe('listCacheDirs', () => {
  test('dossiers réels hors familles connues, triés par taille ; liens, fichiers et familles jamais listés', async () => {
    const { home, roots, du } = fakeHome();
    const r = await listCacheDirs(roots, { du, mountinfo: () => '' });
    expect(r.refusal).toBeNull();
    expect(r.dirs).toEqual([
      { name: 'outil-inconnu', path: join(home, '.cache/outil-inconnu'), sizeKB: 68, refusal: null },
      { name: 'vignettes', path: join(home, '.cache/vignettes'), sizeKB: 8, refusal: null },
    ]);
  });
  test('point de montage dessous : listé mais refusé', async () => {
    const { home, roots, du } = fakeHome();
    const mi = `36 35 0:40 / ${join(home, '.cache/vignettes/m')} rw - ext4 /dev/sdb1 rw\n`;
    const r = await listCacheDirs(roots, { du, mountinfo: () => mi });
    expect(r.dirs.find((x) => x.name === 'vignettes')?.refusal).toBe('point de montage dessous');
  });
  test('XDG_CACHE_HOME inhabituel : rien listé, raison donnée', async () => {
    const { home, roots, du } = fakeHome();
    mkdirSync(join(home, 'Documents'), { recursive: true });
    const r = await listCacheDirs({ ...roots, cacheHome: join(home, 'Documents') }, { du, mountinfo: () => '' });
    expect(r.dirs).toEqual([]);
    expect(r.refusal).toMatch(/racine XDG inhabituelle/);
  });
});

describe('checkCacheDir / removeCacheDir', () => {
  const deps = { mountinfo: () => '', dirUser: () => null };
  test('noms refusés : composant multiple, « .. », famille connue', () => {
    const { roots } = fakeHome();
    for (const n of ['../precieux', '..', 'a/b', 'uv', 'google-chrome', 'paquet.asar']) expect(checkCacheDir(roots, n, deps), n).toBe('nom refusé');
  });
  test('lien vers un dossier précieux : refusé, cible intacte', () => {
    const { base, roots } = fakeHome();
    expect(checkCacheDir(roots, 'lien-precieux', deps)).toMatch(/lien symbolique/);
    expect(() => removeCacheDir(roots, 'lien-precieux', { mountinfo: () => '' })).toThrow(/lien symbolique/);
    expect(readdirSync(join(base, 'precieux'))).toEqual(['these.odt']);
  });
  test('utilisé par un processus : refusé', () => {
    const { home, roots } = fakeHome();
    expect(checkCacheDir(roots, 'outil-inconnu', { ...deps, dirUser: (d) => (d === join(home, '.cache/outil-inconnu') ? { pid: 77, name: 'outil' } : null) })).toBe('utilisé par outil (pid 77)');
  });
  test('suppression sous noAsar, voisins intacts', () => {
    const { home, roots } = fakeHome();
    expect(checkCacheDir(roots, 'outil-inconnu', deps)).toBeNull();
    let during: unknown;
    removeCacheDir(roots, 'outil-inconnu', {
      mountinfo: () => '',
      remove: (rs, p, o) => {
        during = (process as unknown as { noAsar?: boolean }).noAsar;
        return removeTreeSafe(rs, p, o);
      },
    });
    expect(during).toBe(true);
    expect(existsSync(join(home, '.cache/outil-inconnu'))).toBe(false);
    expect(existsSync(join(home, '.cache/vignettes/a.png'))).toBe(true);
    expect(existsSync(join(home, '.cache/uv/CACHEDIR.TAG'))).toBe(true);
    expect((process as unknown as { noAsar?: boolean }).noAsar).toBeUndefined();
  });
  test('suppression refusée pour un nom refusé, rien touché', () => {
    const { home, roots } = fakeHome();
    for (const n of ['uv', '..', 'paquet.asar']) expect(() => removeCacheDir(roots, n, { mountinfo: () => '' }), n).toThrow('nom refusé');
    expect(existsSync(join(home, '.cache/uv/CACHEDIR.TAG'))).toBe(true);
    expect(existsSync(join(home, '.cache/paquet.asar/x'))).toBe(true);
  });
});
