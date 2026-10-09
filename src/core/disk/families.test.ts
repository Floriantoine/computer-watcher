import { describe, expect, test } from 'vitest';
import { browserVersionsToDrop, FAMILIES, familyPaths, familyRoots, isFamilyRequest, pacmanReclaimKB, vercmp, type FamilyId } from './families';

const r = { home: '/h', configHome: '/h/.config', dataHome: '/h/.local/share', cacheHome: '/h/.cache' };

test('liste fermée : 12 familles, deux en root, badges', () => {
  expect(FAMILIES.map((f) => f.id)).toEqual(['npm', 'pnpm', 'yarn', 'uv', 'pip', 'cargo', 'paru', 'yay', 'test-browsers', 'trash', 'pkg-cache', 'journal']);
  expect(FAMILIES.filter((f) => f.root).map((f) => f.id)).toEqual(['pkg-cache', 'journal']);
  expect(FAMILIES.find((f) => f.id === 'test-browsers')!.badge).toBe('keep-latest');
  expect(FAMILIES.find((f) => f.id === 'npm')!.badge).toBe('rebuild');
  expect(FAMILIES.find((f) => f.id === 'journal')!.badge).toBe('root');
});

test('familyPaths : XDG par défaut', () => {
  const p = (id: FamilyId) => familyPaths(id, r);
  expect(p('npm')).toEqual(['/h/.npm/_cacache']);
  expect(p('pnpm')).toEqual(['/h/.local/share/pnpm/store']);
  expect(p('yarn')).toEqual(['/h/.cache/yarn']);
  expect(p('uv')).toEqual(['/h/.cache/uv']);
  expect(p('pip')).toEqual(['/h/.cache/pip']);
  expect(p('cargo')).toEqual(['/h/.cargo/registry/cache', '/h/.cargo/registry/src', '/h/.cargo/git/checkouts']);
  expect(p('paru')).toEqual(['/h/.cache/paru']);
  expect(p('yay')).toEqual(['/h/.cache/yay']);
  expect(p('test-browsers')).toEqual(['/h/.cache/ms-playwright', '/h/.cache/puppeteer']);
  expect(p('trash')).toEqual(['/h/.local/share/Trash/files', '/h/.local/share/Trash/info']);
  expect(p('pkg-cache')).toEqual(['/var/cache/pacman/pkg', '/var/cache/apt/archives']);
  expect(p('journal')).toEqual(['/var/log/journal']);
});

test('familyPaths : XDG définis (absolus) ; relatifs ignorés', () => {
  const env = { XDG_CACHE_HOME: '/x/cache', XDG_DATA_HOME: '/x/data', XDG_CONFIG_HOME: 'relatif' };
  const roots = familyRoots(env, '/h');
  expect(roots).toEqual({ home: '/h', configHome: '/h/.config', dataHome: '/x/data', cacheHome: '/x/cache' });
  expect(familyPaths('uv', roots)).toEqual(['/x/cache/uv']);
  expect(familyPaths('pnpm', roots)).toEqual(['/x/data/pnpm/store']);
  expect(familyPaths('trash', roots)).toEqual(['/x/data/Trash/files', '/x/data/Trash/info']);
  expect(familyPaths('npm', roots)).toEqual(['/h/.npm/_cacache']);
});

describe('browserVersionsToDrop : garde le numéro le plus élevé par navigateur', () => {
  test('playwright : plusieurs navigateurs', () => {
    expect(browserVersionsToDrop(['chromium-1140', 'chromium-1155', 'firefox-1466', 'chromium_headless_shell-1140', 'chromium_headless_shell-1155', 'ffmpeg-1010']).sort())
      .toEqual(['chromium-1140', 'chromium_headless_shell-1140']);
  });
  test('versions non numériques et fichiers annexes : jamais supprimés', () => {
    expect(browserVersionsToDrop(['chromium-1140', 'chromium-latest', '.links', '__dirlock', 'chromium-1155', 'webkit', 'chromium-abc'])).toEqual(['chromium-1140']);
  });
  test('puppeteer : versions pointées comparées par nombre', () => {
    expect(browserVersionsToDrop(['linux-131.0.6778.85', 'linux-99.0.1', 'linux-131.0.6778.204'])).toEqual(['linux-131.0.6778.85', 'linux-99.0.1']);
  });
  test('une seule version : rien', () => {
    expect(browserVersionsToDrop(['firefox-1466'])).toEqual([]);
  });
});

describe('vercmp (comparaison pacman simplifiée)', () => {
  test.each([
    ['1:2.0-1', '1.9-3', 1],
    ['2.10', '2.9', 1],
    ['1.0-2', '1.0-10', -1],
    ['1.0', '1.0', 0],
    ['1.0a', '1.0', -1],
    ['1.0.1', '1.0', 1],
  ])('%s vs %s', (a, b, want) => {
    expect(Math.sign(vercmp(a, b))).toBe(want);
    expect(Math.sign(vercmp(b, a))).toBe(want === 0 ? 0 : -want);
  });
});

test('pacmanReclaimKB : garde les 2 versions les plus récentes par paquet (signatures comprises)', () => {
  const files = [
    { name: 'linux-6.18.1-1-x86_64.pkg.tar.zst', sizeKB: 100 },
    { name: 'linux-6.18.1-1-x86_64.pkg.tar.zst.sig', sizeKB: 1 },
    { name: 'linux-6.18.10-1-x86_64.pkg.tar.zst', sizeKB: 120 },
    { name: 'linux-6.18.9-2-x86_64.pkg.tar.zst', sizeKB: 110 },
    { name: 'lib32-glibc-2.40-1-x86_64.pkg.tar.zst', sizeKB: 30 },
    { name: 'lib32-glibc-2.41-1-x86_64.pkg.tar.zst', sizeKB: 30 },
    { name: 'python-pip-1:24.0-1-any.pkg.tar.zst', sizeKB: 5 },
    { name: 'python-pip-23.9-1-any.pkg.tar.zst', sizeKB: 7 },
    { name: 'python-pip-23.8-1-any.pkg.tar.zst', sizeKB: 9 },
    { name: 'download-abc', sizeKB: 999 },
  ];
  // linux 6.18.1 (100 + 1) et python-pip 23.8 (9) en trop
  expect(pacmanReclaimKB(files, 2)).toBe(110);
  expect(pacmanReclaimKB(files, 1)).toBe(110 + 110 + 30 + 7);
});

test('requête du renderer : ids connus, sans doublon, au moins un', () => {
  expect(isFamilyRequest(['npm', 'uv'])).toBe(true);
  expect(isFamilyRequest([])).toBe(false);
  expect(isFamilyRequest(['npm', 'npm'])).toBe(false);
  expect(isFamilyRequest(['npm', '../etc'])).toBe(false);
  expect(isFamilyRequest('npm')).toBe(false);
  expect(isFamilyRequest([1])).toBe(false);
});
