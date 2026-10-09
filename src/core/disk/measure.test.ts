import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import type { FamilyRoots } from './families';
import { measureFamilies, parseJournalUsage, readFamiliesFile, writeFamiliesFile } from './measure';

mkdirSync(join(homedir(), '.cache'), { recursive: true });
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function fakeHome() {
  const base = realpathSync(mkdtempSync(join(homedir(), '.cache', 'pw-disk-measure-')));
  made.push(base);
  const home = join(base, 'home');
  const roots: FamilyRoots = { home, configHome: join(home, '.config'), dataHome: join(home, '.local/share'), cacheHome: join(home, '.cache') };
  const fill = (p: string, kb: number) => {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, Buffer.alloc(kb * 1024, 1));
  };
  fill(join(home, '.npm/_cacache/a'), 512);
  fill(join(home, '.cache/uv/b'), 256);
  fill(join(home, '.cache/ms-playwright/chromium-1140/x'), 128);
  fill(join(home, '.cache/ms-playwright/chromium-1155/x'), 64);
  return { base, home, roots };
}

test('une mesure par famille présente (absentes omises), « libère » selon la famille, heure', async () => {
  const { roots } = fakeHome();
  const m = await measureFamilies(roots, { pkgDirs: [], journal: null, now: () => 1234 });
  expect(m.map((x) => x.id)).toEqual(['npm', 'uv', 'test-browsers']);
  const by = Object.fromEntries(m.map((x) => [x.id, x]));
  expect(by.npm.sizeKB).toBeGreaterThanOrEqual(512);
  expect(by.npm.reclaimKB).toBe(by.npm.sizeKB);
  expect(by.uv.sizeKB).toBeGreaterThanOrEqual(256);
  expect(by['test-browsers'].sizeKB).toBeGreaterThanOrEqual(192);
  expect(by['test-browsers'].reclaimKB).toBeGreaterThanOrEqual(128); // seulement chromium-1140
  expect(by['test-browsers'].reclaimKB).toBeLessThan(192);
  expect(by.npm.at).toBe(1234);
});

test('cache de paquets pacman : taille et estimation (2 versions gardées) ; journaux : taille inconnue si illisible', async () => {
  const { base, roots } = fakeHome();
  const pkg = join(base, 'pkg');
  mkdirSync(pkg);
  for (const [n, kb] of [['a-1.0-1-x86_64.pkg.tar.zst', 10], ['a-1.1-1-x86_64.pkg.tar.zst', 10], ['a-1.2-1-x86_64.pkg.tar.zst', 10]] as const)
    writeFileSync(join(pkg, n), Buffer.alloc(kb * 1024, 1));
  const m = await measureFamilies(roots, { pkgDirs: [pkg], journal: async () => null, now: () => 1 });
  const p = m.find((x) => x.id === 'pkg-cache')!;
  expect(p.sizeKB).toBeGreaterThanOrEqual(30);
  expect(p.reclaimKB).toBeGreaterThanOrEqual(10);
  expect(p.reclaimKB).toBeLessThan(20);
  expect(m.find((x) => x.id === 'journal')).toMatchObject({ sizeKB: null, reclaimKB: null });
});

test('journalctl --disk-usage : lu en Ko ; « libère » = au-delà de 500 Mo', () => {
  expect(parseJournalUsage('Archived and active journals take up 3.9G in the file system.')).toBe(Math.round(3.9 * 1024 * 1024));
  expect(parseJournalUsage('Journals take up 120.0M on disk.')).toBe(120 * 1024);
  expect(parseJournalUsage('rien')).toBeNull();
});

test('disk-families.json : écrit puis relu ; illisible → null', () => {
  const { base } = fakeHome();
  const f = join(base, 'disk-families.json');
  writeFamiliesFile(f, { at: 5, families: [{ id: 'npm', sizeKB: 1, reclaimKB: 1, at: 5 }] });
  expect(readFamiliesFile(f)).toEqual({ at: 5, families: [{ id: 'npm', sizeKB: 1, reclaimKB: 1, at: 5 }] });
  writeFileSync(f, '{pas du json');
  expect(readFamiliesFile(f)).toBeNull();
  expect(JSON.parse(readFileSync(f, 'utf8').replace('{pas du json', '{}'))).toEqual({});
});
