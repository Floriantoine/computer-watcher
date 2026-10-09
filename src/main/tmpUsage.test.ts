import { chmodSync, mkdirSync, promises as fsp, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { TmpUsage } from '../core/types';
import { TMP_SCAN_LIMITS } from '../core/tmpScanLimits';
import { mountPointsUnder, sharedScan, topTmpDirs, type ScanFs } from './tmpUsage';

const KB = 1024;
const fill = (p: string, kb: number) => writeFileSync(p, Buffer.alloc(kb * KB, 1));

/** Racine jetable : a/ (3 × 64 Ko), b/ (2 × 64 Ko), c/ (1 × 300 Ko), un fichier racine de 16 Ko. */
function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'pw-tmp-'));
  for (const [d, files, kb] of [['a', 3, 64], ['b', 2, 64], ['c', 1, 300]] as const) {
    mkdirSync(join(root, d));
    for (let i = 0; i < files; i++) fill(join(root, d, `f${i}`), kb);
  }
  fill(join(root, 'racine.bin'), 16);
  return root;
}

test('plus gros dossiers de premier niveau, décroissants, fichiers racine comptés à part', async () => {
  const root = tree();
  const r = await topTmpDirs(root);
  expect(r.dirs.map((d) => d.path)).toEqual([join(root, 'c'), join(root, 'a'), join(root, 'b')]);
  expect(r.dirs[0].sizeKB).toBeGreaterThanOrEqual(300);
  expect(r.dirs[1].sizeKB).toBeGreaterThanOrEqual(192);
  expect(r.rootFilesKB).toBeGreaterThanOrEqual(16);
  expect(r).toMatchObject({ skipped: 0, truncated: false });
});

test('limit : 2 dossiers', async () => {
  const r = await topTmpDirs(tree(), { limit: 2 });
  expect(r.dirs).toHaveLength(2);
});

test.skipIf(process.getuid?.() === 0)('dossier illisible : ignoré et compté, pas d’exception', async () => {
  const root = tree();
  const locked = join(root, 'verrou');
  mkdirSync(locked);
  fill(join(locked, 'secret'), 500);
  chmodSync(locked, 0);
  try {
    const r = await topTmpDirs(root);
    expect(r.skipped).toBe(1);
    expect(r.dirs.map((d) => d.path)).not.toContain(locked);
    expect(r.dirs).toHaveLength(3);
  } finally {
    chmodSync(locked, 0o700);
  }
});

test('liens symboliques jamais suivis (lien vers un gros dossier, boucle a/loop → ..)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pw-tmp-'));
  const big = mkdtempSync(join(tmpdir(), 'pw-big-'));
  fill(join(big, 'gros'), 2048);
  mkdirSync(join(root, 'liens'));
  symlinkSync(big, join(root, 'liens', 'vers-gros'));
  mkdirSync(join(root, 'liens', 'a'));
  symlinkSync('..', join(root, 'liens', 'a', 'loop'));
  symlinkSync(big, join(root, 'lien-racine'));
  const r = await topTmpDirs(root);
  expect(r.dirs).toHaveLength(1);
  expect(r.dirs[0].path).toBe(join(root, 'liens'));
  expect(r.dirs[0].sizeKB).toBeLessThan(2048);
  expect(r.rootFilesKB).toBeLessThan(2048);
  expect(r.truncated).toBe(false);
});

test.skipIf(!process.env.PROC_WATCH_REAL_TMP)('vrai /tmp (opt-in, lecture seule) : jamais de point de montage sous /tmp dans la liste', async () => {
  const unescape = (s: string) => s.replace(/\\(\d{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
  const mounts = readFileSync('/proc/self/mountinfo', 'utf8')
    .split('\n')
    .map((l) => unescape(l.split(' ')[4] ?? ''))
    .filter((m) => m.startsWith('/tmp/'));
  const r = await topTmpDirs('/tmp');
  for (const d of r.dirs) {
    for (const m of mounts) {
      expect(d.path === m || d.path.startsWith(`${m}/`), `${d.path} est (sous) le montage ${m}`).toBe(false);
    }
  }
}, 10_000);

test('maxEntries : arrêt et tailles « au moins »', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pw-tmp-'));
  mkdirSync(join(root, 'd'));
  for (let i = 0; i < 50; i++) fill(join(root, 'd', `f${i}`), 1);
  const r = await topTmpDirs(root, { maxEntries: 10 });
  expect(r.truncated).toBe(true);
});

test('budgetMs : arrêt quand l’horloge dépasse le budget', async () => {
  let t = 0;
  const r = await topTmpDirs(tree(), { budgetMs: 0, now: () => t++ });
  expect(r.truncated).toBe(true);
});

test('racine absente', async () => {
  expect(await topTmpDirs(join(tmpdir(), 'pw-absent-xyz'))).toEqual({ dirs: [], rootFilesKB: 0, skipped: 1, truncated: false });
});

test('sharedScan : un seul parcours à la fois, résultat réutilisé 30 s, puis nouveau parcours', async () => {
  let calls = 0;
  let t = 0;
  let release!: () => void;
  const get = sharedScan(
    () => {
      calls++;
      return new Promise<TmpUsage>((res) => {
        release = () => res({ dirs: [], rootFilesKB: calls, skipped: 0, truncated: false });
      });
    },
    { now: () => t },
  );
  const a = get();
  const b = get();
  expect(calls).toBe(1);
  release();
  expect(await a).toBe(await b);
  t = 29_000;
  expect((await get()).rootFilesKB).toBe(1);
  expect(calls).toBe(1);
  t = 31_000;
  const c = get();
  expect(calls).toBe(2);
  release();
  expect((await c).rootFilesKB).toBe(2);
});

test('plafond par défaut : 100 000 entrées et 2 s ; 25 000 entrées parcourues sans arrêt', async () => {
  expect(TMP_SCAN_LIMITS).toEqual({ maxEntries: 100_000, budgetMs: 2_000 });
  const root = mkdtempSync(join(tmpdir(), 'pw-tmp-'));
  mkdirSync(join(root, 'beaucoup'));
  for (let i = 0; i < 25_000; i++) writeFileSync(join(root, 'beaucoup', `f${i}`), '');
  // budget de temps neutralisé : seul le plafond d'entrées compte ici
  const r = await topTmpDirs(root, { budgetMs: 60_000 });
  expect(r.truncated).toBe(false);
}, 60_000);

const realFs: ScanFs = { opendir: (p) => fsp.opendir(p), lstat: (p) => fsp.lstat(p) };
const never = <T,>() => new Promise<T>(() => {});

test('points de montage sous la racine (mountinfo) ignorés par chemin, AVANT tout lstat', async () => {
  const root = tree();
  const mount = join(root, '.mount_appXYZ');
  mkdirSync(mount);
  fill(join(mount, 'gros'), 500);
  const touched: string[] = [];
  const fs: ScanFs = {
    opendir: (p) => (p.startsWith(mount) ? never() : realFs.opendir(p)),
    lstat: (p) => {
      touched.push(p);
      return p.startsWith(mount) ? never() : realFs.lstat(p);
    },
  };
  const r = await topTmpDirs(root, { fs, mountPoints: async () => [mount], hardTimeoutMs: 5_000 });
  expect(touched.filter((p) => p.startsWith(mount))).toEqual([]);
  expect(r.dirs.map((d) => d.path)).not.toContain(mount);
  expect(r).toMatchObject({ truncated: false, skipped: 0 });
});

test('mountPointsUnder : points de montage strictement sous la racine, échappements décodés', async () => {
  const info = [
    '22 1 0:21 / / rw - btrfs /dev/x rw',
    '30 22 0:30 / /tmp rw - tmpfs tmpfs rw',
    '41 30 0:41 / /tmp/.mount_App\\040x rw - fuse.App App rw',
    '42 30 0:42 / /tmp/sshfs rw - fuse.sshfs host: rw',
    '43 22 0:43 / /tmpautre rw - tmpfs tmpfs rw',
  ].join('\n');
  expect([...(await mountPointsUnder('/tmp', async () => info))].sort()).toEqual(['/tmp/.mount_App x', '/tmp/sshfs']);
  expect([...(await mountPointsUnder('/tmp', async () => { throw new Error('ENOENT'); }))]).toEqual([]);
});

test('lstat qui ne rend jamais la main : délai dur, résultat partiel, jamais « Calcul… » sans fin', async () => {
  const root = tree();
  const fs: ScanFs = { opendir: realFs.opendir, lstat: () => never() };
  const t0 = Date.now();
  const r = await topTmpDirs(root, { fs, mountPoints: async () => [], hardTimeoutMs: 200 });
  expect(Date.now() - t0).toBeLessThan(2_000);
  expect(r.truncated).toBe(true);
  // la promesse partagée se règle aussi
  const shared = sharedScan(() => topTmpDirs(root, { fs, mountPoints: async () => [], hardTimeoutMs: 200 }));
  expect((await shared()).truncated).toBe(true);
});

test('opendir qui ne rend jamais la main sur un sous-dossier : résultat partiel avec les autres dossiers', async () => {
  const root = tree();
  const fs: ScanFs = { opendir: (p) => (p === join(root, 'b') ? never() : realFs.opendir(p)), lstat: realFs.lstat };
  const r = await topTmpDirs(root, { fs, mountPoints: async () => [], hardTimeoutMs: 300 });
  expect(r.truncated).toBe(true);
  expect(r.dirs.map((d) => d.path)).toContain(join(root, 'c'));
});

test('erreur au milieu de la lecture d’un dossier : liste partielle, dossier compté illisible', async () => {
  const root = tree();
  const fs: ScanFs = {
    lstat: realFs.lstat,
    opendir: async (p) => {
      if (p !== join(root, 'a')) return realFs.opendir(p);
      return (async function* () {
        yield { name: 'f0', isDirectory: () => false };
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      })();
    },
  };
  const r = await topTmpDirs(root, { fs, mountPoints: async () => [] });
  expect(r.dirs.map((d) => d.path)).toEqual([join(root, 'c'), join(root, 'b'), join(root, 'a')]);
  expect(r.dirs[2].sizeKB).toBeGreaterThanOrEqual(64);
  expect(r.skipped).toBe(1);
});

test('lstat par lots parallèles (au plus 64 à la fois)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pw-tmp-'));
  mkdirSync(join(root, 'd'));
  for (let i = 0; i < 300; i++) fill(join(root, 'd', `f${i}`), 1);
  let inFlight = 0;
  let peak = 0;
  const fs: ScanFs = {
    opendir: realFs.opendir,
    lstat: async (p) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return realFs.lstat(p);
    },
  };
  const r = await topTmpDirs(root, { fs, mountPoints: async () => [] });
  expect(r.dirs[0].sizeKB).toBeGreaterThanOrEqual(300);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(64);
});

test('sharedScan.reset : le résultat en cache est oublié (après une suppression)', async () => {
  let calls = 0;
  const get = sharedScan(async () => ({ dirs: [], rootFilesKB: ++calls, skipped: 0, truncated: false }), { now: () => 0 });
  expect((await get()).rootFilesKB).toBe(1);
  expect((await get()).rootFilesKB).toBe(1);
  get.reset();
  expect((await get()).rootFilesKB).toBe(2);
});
