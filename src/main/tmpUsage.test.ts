import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { TmpUsage } from '../core/types';
import { sharedScan, topTmpDirs } from './tmpUsage';

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

test('vrai /tmp (lecture seule) : jamais de point de montage sous /tmp (AppImage /tmp/.mount_*) dans la liste', async () => {
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

test('sharedScan : un seul parcours à la fois, la promesse en cours est réutilisée, puis un nouveau parcours', async () => {
  let calls = 0;
  let release!: () => void;
  const get = sharedScan(() => {
    calls++;
    return new Promise<TmpUsage>((res) => {
      release = () => res({ dirs: [], rootFilesKB: calls, skipped: 0, truncated: false });
    });
  });
  const a = get();
  const b = get();
  expect(calls).toBe(1);
  release();
  expect(await a).toBe(await b);
  const c = get();
  expect(calls).toBe(2);
  release();
  expect((await c).rootFilesKB).toBe(2);
});
