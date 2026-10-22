// Mesure et vidage des caches connus : toujours dans une fausse racine sous la racine du lancement (~/.cache/pw-vitest),
// jamais le vrai /tmp.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import * as nodeFsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { tmpCacheName } from './tmpCaches';
import { emptyTmpCaches, measureTmpCaches, type CachesFs } from './tmpCachesClean';

const UID = process.getuid!();
const KB = 1024;
const noMounts = async () => '';
const fill = (p: string, kb: number) => writeFileSync(p, Buffer.alloc(kb * KB, 7));
/** Taille réellement allouée (blocs), comme la mesure : indépendante du système de fichiers de la racine de test. */
const used = (...paths: string[]) => paths.reduce((s, p) => s + lstatSync(p).blocks / 2, 0);

/** Fausse /tmp : jest_<uid>, node-compile-cache, un dossier ordinaire et tsx-<uid> (jamais listés), cibles « dehors ». */
function setup() {
  const base = mkdtempSync(join(tmpdir(), 'pw-caches-'));
  const root = join(base, 'root');
  const out = join(base, 'dehors');
  mkdirSync(join(out, 'dossier'), { recursive: true });
  writeFileSync(join(out, 'precieux.txt'), 'garder');
  writeFileSync(join(out, 'dossier', 'f.txt'), 'garder aussi');
  const jest = join(root, tmpCacheName('jest', UID));
  mkdirSync(join(jest, 'jest-transform-cache-abc', '0f'), { recursive: true });
  fill(join(jest, 'jest-transform-cache-abc', '0f', 'mod_0f12'), 256);
  fill(join(jest, 'haste-map-abc'), 128);
  fill(join(jest, 'perf-cache-abc'), 64);
  symlinkSync(out, join(jest, 'lien-dossier'));
  symlinkSync(join(out, 'precieux.txt'), join(jest, 'lien-fichier'));
  const ncc = join(root, 'node-compile-cache');
  mkdirSync(join(ncc, 'v24.0.0-x64-abc-1000'), { recursive: true });
  fill(join(ncc, 'v24.0.0-x64-abc-1000', '0026279'), 96);
  mkdirSync(join(root, 'autre'));
  fill(join(root, 'autre', 'x.bin'), 64);
  mkdirSync(join(root, `tsx-${UID}`));
  fill(join(root, `tsx-${UID}`, 'cache'), 64);
  const files = [join(jest, 'jest-transform-cache-abc', '0f', 'mod_0f12'), join(jest, 'haste-map-abc'), join(jest, 'perf-cache-abc')];
  return { base, root, out, jest, ncc, files };
}
const outsideIntact = (out: string) => {
  expect(readFileSync(join(out, 'precieux.txt'), 'utf8')).toBe('garder');
  expect(readFileSync(join(out, 'dossier', 'f.txt'), 'utf8')).toBe('garder aussi');
};

describe('measureTmpCaches', () => {
  test('seulement les caches connus présents, dans l’ordre de la liste, avec la place de leurs fichiers', async () => {
    const s = setup();
    const r = await measureTmpCaches(s.root, { mountinfo: noMounts });
    expect(r.root).toBe(s.root);
    expect(r.caches.map((c) => c.name)).toEqual([tmpCacheName('jest', UID), 'node-compile-cache']);
    expect(r.caches[0]).toEqual({ id: 'jest', name: tmpCacheName('jest', UID), sizeKB: Math.round(used(...s.files) + used(join(s.jest, 'lien-dossier'), join(s.jest, 'lien-fichier'))), atLeast: false, refusal: null });
    expect(r.caches[1].sizeKB).toBe(Math.round(used(join(s.ncc, 'v24.0.0-x64-abc-1000', '0026279'))));
    expect(r.caches[0].sizeKB).toBeGreaterThanOrEqual(448);
  });

  test('refus : lien symbolique (jamais suivi), pas un dossier, modifiable par d’autres, point de montage, montage dessous', async () => {
    const s = setup();
    const v8 = join(s.root, `v8-compile-cache-${UID}`);
    symlinkSync(s.out, v8);
    writeFileSync(join(s.root, `playwright-transform-cache-${UID}`), 'fichier');
    chmodSync(s.ncc, 0o777);
    let r = await measureTmpCaches(s.root, { mountinfo: noMounts });
    const why = Object.fromEntries(r.caches.map((c) => [c.id, c.refusal]));
    expect(why).toEqual({ jest: null, 'node-compile-cache': 'modifiable par d’autres utilisateurs', 'v8-compile-cache': 'lien symbolique (jamais suivi)', 'playwright-transform-cache': 'pas un dossier' });
    chmodSync(s.ncc, 0o755);
    const mi = `40 25 0:90 / ${s.jest} rw - fuse.x x rw\n41 25 0:91 / ${join(s.ncc, 'v24.0.0-x64-abc-1000')} rw - tmpfs t rw\n`;
    r = await measureTmpCaches(s.root, { mountinfo: async () => mi });
    expect(r.caches.find((c) => c.id === 'jest')?.refusal).toBe('point de montage');
    expect(r.caches.find((c) => c.id === 'node-compile-cache')?.refusal).toBe('contient un point de montage');
    outsideIntact(s.out);
  });

  test('autre propriétaire, ou l’app en root : refusés', async () => {
    const s = setup();
    const other = UID + 1;
    mkdirSync(join(s.root, tmpCacheName('jest', other)));
    expect((await measureTmpCaches(s.root, { uid: other, mountinfo: noMounts })).caches[0]).toMatchObject({ refusal: 'autre utilisateur' });
    mkdirSync(join(s.root, 'jest_0'));
    expect((await measureTmpCaches(s.root, { uid: 0, mountinfo: noMounts })).caches[0].refusal).toMatch(/tourne en root/);
  });

  test('mesure coupée (budget) : « au moins » ; points de montage illisibles : listés, refusés', async () => {
    const s = setup();
    let t = 0;
    const r = await measureTmpCaches(s.root, { mountinfo: noMounts, budgetMs: 1, now: () => t++ });
    expect(r.caches.some((c) => c.atLeast)).toBe(true);
    const u = await measureTmpCaches(s.root, { mountinfo: async () => { throw new Error('EACCES'); } });
    expect(u.caches.map((c) => c.refusal)).toEqual(['impossible de vérifier (points de montage illisibles)', 'impossible de vérifier (points de montage illisibles)']);
  });
});

describe('emptyTmpCaches', () => {
  test('fichiers supprimés, dossiers gardés (Jest y écrit sans les recréer), liens supprimés sans être suivis', async () => {
    const s = setup();
    const freed = used(...s.files) + used(join(s.jest, 'lien-dossier'), join(s.jest, 'lien-fichier'));
    const r = await emptyTmpCaches(s.root, ['jest'], { mountinfo: noMounts });
    expect(r).toEqual({ results: [{ id: 'jest', name: tmpCacheName('jest', UID), ok: true, freedKB: Math.round(freed) }], freedKB: Math.round(freed) });
    expect(readdirSync(s.jest).sort()).toEqual(['jest-transform-cache-abc']);
    expect(readdirSync(join(s.jest, 'jest-transform-cache-abc'))).toEqual(['0f']);
    expect(readdirSync(join(s.jest, 'jest-transform-cache-abc', '0f'))).toEqual([]);
    expect(statSync(s.jest).isDirectory()).toBe(true);
    outsideIntact(s.out);
    // jamais un autre élément de la racine
    expect(existsSync(join(s.root, 'autre', 'x.bin'))).toBe(true);
    expect(existsSync(join(s.ncc, 'v24.0.0-x64-abc-1000', '0026279'))).toBe(true);
    expect(existsSync(join(s.root, `tsx-${UID}`, 'cache'))).toBe(true);
  });

  test('dossier ou sous-dossier sans droit d’écriture (à nous) : rendu u+rwx, vidé ; sous-dossier modifiable par d’autres : jamais parcouru', async () => {
    const s = setup();
    const ro = join(s.ncc, 'v24.0.0-x64-abc-1000');
    chmodSync(ro, 0o500);
    const shared = join(s.jest, 'partage');
    mkdirSync(shared);
    fill(join(shared, 'x'), 8);
    chmodSync(shared, 0o777);
    const pw = join(s.root, `playwright-transform-cache-${UID}`);
    mkdirSync(join(pw, '0a'), { recursive: true });
    fill(join(pw, '0a', 'f.js'), 4);
    fill(join(pw, 'direct.js'), 4);
    chmodSync(pw, 0o500);
    const r = await emptyTmpCaches(s.root, ['jest', 'node-compile-cache', 'playwright-transform-cache'], { mountinfo: noMounts });
    expect(r.results.find((x) => x.id === 'playwright-transform-cache')).toMatchObject({ ok: true });
    expect(readdirSync(pw)).toEqual(['0a']);
    expect(readdirSync(join(pw, '0a'))).toEqual([]);
    expect(readdirSync(ro)).toEqual([]);
    expect(existsSync(join(shared, 'x'))).toBe(true);
    const jest = r.results.find((x) => x.id === 'jest')!;
    expect(jest).toMatchObject({ ok: false, partial: true, reason: '1 dossier ignoré (autre propriétaire, droits ou point de montage)' });
    expect(r.results.find((x) => x.id === 'node-compile-cache')).toMatchObject({ ok: true });
    chmodSync(shared, 0o755);
  });

  test('refusés : rien n’est touché ; absent : pas de résultat ; montage dessous : jamais parcouru', async () => {
    const s = setup();
    chmodSync(s.ncc, 0o777);
    const mi = `40 25 0:90 / ${join(s.jest, 'jest-transform-cache-abc', '0f')} rw - fuse.x x rw\n`;
    const r = await emptyTmpCaches(s.root, ['jest', 'node-compile-cache', 'v8-compile-cache'], { mountinfo: async () => mi });
    expect(r).toEqual({
      results: [
        { id: 'jest', name: tmpCacheName('jest', UID), ok: false, freedKB: 0, reason: 'contient un point de montage' },
        { id: 'node-compile-cache', name: 'node-compile-cache', ok: false, freedKB: 0, reason: 'modifiable par d’autres utilisateurs' },
      ],
      freedKB: 0,
    });
    for (const f of s.files) expect(existsSync(f)).toBe(true);
    chmodSync(s.ncc, 0o755);
    const u = await emptyTmpCaches(s.root, ['jest'], { mountinfo: async () => { throw new Error('EACCES'); } });
    expect(u.results[0]).toMatchObject({ ok: false, reason: 'impossible de vérifier (points de montage illisibles)' });
    for (const f of s.files) expect(existsSync(f)).toBe(true);
  });

  test('budget écoulé : arrêt, vidé en partie ; fichier déjà disparu (outil qui tourne) : sans erreur', async () => {
    const s = setup();
    let t = 0;
    const r = await emptyTmpCaches(s.root, ['jest'], { mountinfo: noMounts, budgetMs: 2, now: () => t++ });
    expect(r.results[0]).toMatchObject({ ok: false, reason: 'temps écoulé' });
    // ENOENT au moment de supprimer : un autre processus l'a fait, c'est le résultat voulu
    const gone: CachesFs = { ...(nodeFsp as unknown as CachesFs), unlink: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } };
    const r2 = await emptyTmpCaches(s.root, ['node-compile-cache'], { mountinfo: noMounts, fs: gone });
    expect(r2.results[0]).toMatchObject({ ok: true });
  });
});

test('défense en profondeur : aucun nom figé n’est dans la liste système de /tmp (claude-*, ssh-*, .X11-unix…) ni une quarantaine', async () => {
  const { systemEntry, isTrashName } = await import('./tmpClean');
  const { TMP_CACHE_IDS } = await import('./tmpCaches');
  for (const uid of [0, 1, 1000, 1001, 65534, 4294967294]) {
    for (const id of TMP_CACHE_IDS) {
      const name = tmpCacheName(id, uid);
      expect(systemEntry(name) || isTrashName(name) || name.includes('/') || name.startsWith('.'), name).toBe(false);
    }
  }
});
