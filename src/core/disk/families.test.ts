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

describe('revue I1 (a) : racine XDG égale à HOME ou hors de HOME', () => {
  const home = '/h';
  test('XDG_CACHE_HOME=$HOME : familles du cache refusées ; npm et cargo (chemins fixes sous HOME) gardés ; root non concernées', async () => {
    const { familyRootRefusal } = await import('./families');
    const roots = familyRoots({ XDG_CACHE_HOME: home, XDG_DATA_HOME: home }, home);
    for (const id of ['uv', 'pip', 'yarn', 'paru', 'yay', 'test-browsers', 'pnpm', 'trash'] as FamilyId[]) expect(familyRootRefusal(id, roots), id).toMatch(/racine XDG inhabituelle/);
    for (const id of ['npm', 'cargo', 'pkg-cache', 'journal'] as FamilyId[]) expect(familyRootRefusal(id, roots), id).toBeNull();
  });
  test('racine hors de HOME (/var/cache, /h2) ou avec « / » final : refusée / acceptée selon le cas', async () => {
    const { familyRootRefusal } = await import('./families');
    expect(familyRootRefusal('uv', familyRoots({ XDG_CACHE_HOME: '/var/cache' }, home))).toMatch(/inhabituelle/);
    expect(familyRootRefusal('uv', familyRoots({ XDG_CACHE_HOME: '/h2' }, home))).toMatch(/inhabituelle/);
    expect(familyRootRefusal('uv', familyRoots({ XDG_CACHE_HOME: '/h/' }, home))).toMatch(/inhabituelle/);
    expect(familyRootRefusal('uv', familyRoots({ XDG_CACHE_HOME: '/h/../h/.cache' }, home))).toBeNull(); // n-2 : le défaut, normalisé
    expect(familyRootRefusal('uv', familyRoots({ XDG_CACHE_HOME: '/h/x/../..' }, home))).toMatch(/inhabituelle/);
    expect(familyRootRefusal('uv', familyRoots({}, home))).toBeNull();
    expect(familyRootRefusal('trash', familyRoots({}, home))).toBeNull();
  });
});

describe('revue I1 (b) : signature de l’outil', () => {
  const tree: Record<string, string[]> = {
    '/c/npm': ['CACHEDIR.TAG', 'content-v2', 'index-v5', 'tmp'],
    '/c/npm-faux': ['content-v2', 'src'],
    '/c/uv': ['archive-v0', 'CACHEDIR.TAG', '.lock', 'sdists-v9'],
    '/c/uv2': ['wheels-v5'],
    '/c/uv-projet': ['src', 'pyproject.toml'],
    '/c/pip': ['http-v2', 'selfcheck', 'wheels'],
    '/c/pip-projet': ['notes.txt'],
    '/c/yarn': ['v6'],
    '/c/yarn/v6': ['npm-a-1.0.0-x'],
    '/c/pnpm': ['v10', 'v11', 'v3'],
    '/c/pnpm/v10': ['files', 'index'],
    '/c/pnpm-faux': ['store.txt'],
    '/c/reg': ['cache', 'CACHEDIR.TAG', 'index', 'src'],
    '/c/git': ['checkouts', 'db'],
    '/c/paru': ['clone', 'packages.aur'],
    '/c/yay': ['firefox-nightly', 'notes'],
    '/c/yay/firefox-nightly': ['PKGBUILD', '.SRCINFO'],
    '/c/yay/notes': ['a.txt'],
    '/c/yay-faux': ['notes'],
    '/c/pw': ['.links', 'chromium-1208', 'ffmpeg-1011'],
    '/c/pw-faux': ['projet-a', 'notes'],
    '/c/pp': ['chrome', 'chrome-headless-shell'],
    '/c/pp/chrome': ['linux-131.0.6778.85'],
    '/c/pp/chrome-headless-shell': [],
    '/c/pp-faux': ['docs'],
    '/c/pp-faux/docs': ['a'],
  };
  const ls = (p: string) => tree[p] ?? null;
  test.each([
    ['npm', '/c/npm', true], ['npm', '/c/npm-faux', false],
    ['uv', '/c/uv', true], ['uv', '/c/uv2', true], ['uv', '/c/uv-projet', false],
    ['pip', '/c/pip', true], ['pip', '/c/pip-projet', false],
    ['yarn', '/c/yarn', true], ['yarn', '/c/pip-projet', false],
    ['pnpm', '/c/pnpm', true], ['pnpm', '/c/pnpm-faux', false],
    ['paru', '/c/paru', true], ['yay', '/c/yay', true], ['yay', '/c/yay-faux', false],
    ['test-browsers', '/c/pw', true], ['test-browsers', '/c/pw-faux', false],
    ['test-browsers', '/c/pp', true], ['test-browsers', '/c/pp-faux', false],
  ] as [FamilyId, string, boolean][])('%s %s → %s', async (id, path, ok) => {
    const { cacheSignature } = await import('./families');
    expect(cacheSignature(id, path, ls)).toBe(ok);
  });
  test('cargo : registry/* exige index ou cache dans registry ; git/checkouts exige git/db', async () => {
    const { cacheSignature } = await import('./families');
    const t: Record<string, string[]> = { '/h/.cargo/registry': ['index', 'cache'], '/h/.cargo/git': ['checkouts', 'db'], '/x/.cargo/registry': ['src'], '/x/.cargo/git': ['checkouts'] };
    const l = (p: string) => t[p] ?? null;
    expect(cacheSignature('cargo', '/h/.cargo/registry/cache', l)).toBe(true);
    expect(cacheSignature('cargo', '/h/.cargo/git/checkouts', l)).toBe(true);
    expect(cacheSignature('cargo', '/x/.cargo/registry/src', l)).toBe(false);
    expect(cacheSignature('cargo', '/x/.cargo/git/checkouts', l)).toBe(false);
  });
  test('corbeille et root : pas de signature exigée', async () => {
    const { cacheSignature } = await import('./families');
    expect(cacheSignature('trash', '/x', () => null)).toBe(true);
    expect(cacheSignature('journal', '/x', () => null)).toBe(true);
  });
});

describe('revue m-2 : versions de navigateurs aberrantes et date de modification', () => {
  test('zéros en tête ou plus de 9 chiffres : ignorés (jamais supprimés, jamais « plus récents »)', () => {
    expect(browserVersionsToDrop(['chromium-1140', 'chromium-1150', 'chromium-0999999999999999999999']).sort()).toEqual(['chromium-1140']);
    expect(browserVersionsToDrop(['chromium-1140', 'chromium-1150', 'chromium-1234567890'])).toEqual(['chromium-1140']);
    expect(browserVersionsToDrop(['linux-131.0.1', 'linux-131.00.2'])).toEqual([]);
  });
  test('la plus récente par date de modification n’est jamais supprimée ; si elle diffère de la plus grande, les deux restent', () => {
    const mtime = (n: string) => ({ 'chromium-1140': 300, 'chromium-1150': 200, 'chromium-1100': 100 })[n] ?? null;
    expect(browserVersionsToDrop(['chromium-1100', 'chromium-1140', 'chromium-1150'], mtime)).toEqual(['chromium-1100']);
    const same = (n: string) => ({ 'chromium-1150': 300, 'chromium-1140': 200 })[n] ?? null;
    expect(browserVersionsToDrop(['chromium-1140', 'chromium-1150'], same)).toEqual(['chromium-1140']);
  });
});

describe('revue n-1 / n-2 : racine XDG comparée en chemin réel, et qui doit ressembler à un dossier de caches', () => {
  const home = '/h';
  const links: Record<string, string> = { '/h/cachelink': '/h', '/h/up': '/', '/h/vers-cache': '/h/.cache' };
  const real = (p: string) => links[p] ?? p;
  const dirs: Record<string, string[]> = {
    '/h/Documents': ['yarn', 'these', 'photos'],
    '/h/caches': ['uv', 'pip', 'autre'],
    '/h/tag': ['CACHEDIR.TAG'],
    '/h/donnees': ['applications', 'icons', 'notes'],
    '/h/perso': ['Trash'],
  };
  const ls = (p: string) => dirs[p] ?? null;
  const o = { real, ls };
  test('n-1 : lien vers HOME ou vers un parent de HOME → refusé, chemin réel affiché', async () => {
    const { familyRootRefusal } = await import('./families');
    expect(familyRootRefusal('pip', familyRoots({ XDG_CACHE_HOME: '/h/cachelink' }, home), o)).toBe('racine XDG inhabituelle (XDG_CACHE_HOME = /h/cachelink → /h), refusé');
    expect(familyRootRefusal('pip', familyRoots({ XDG_CACHE_HOME: '/h/up' }, home), o)).toMatch(/→ \/\), refusé/);
  });
  test('n-2 : défaut (même via un lien), dossier de caches reconnu (2 outils ou CACHEDIR.TAG) → accepté ; dossier d’utilisateur → refusé', async () => {
    const { familyRootRefusal } = await import('./families');
    const r = (env: NodeJS.ProcessEnv) => familyRootRefusal('yarn', familyRoots(env, home), o);
    expect(r({})).toBeNull();
    expect(r({ XDG_CACHE_HOME: '/h/vers-cache' })).toBeNull();
    expect(r({ XDG_CACHE_HOME: '/h/caches' })).toBeNull();
    expect(r({ XDG_CACHE_HOME: '/h/tag' })).toBeNull();
    expect(r({ XDG_CACHE_HOME: '/h/Documents' })).toMatch(/racine XDG inhabituelle/);
    const t = (env: NodeJS.ProcessEnv) => familyRootRefusal('trash', familyRoots(env, home), o);
    expect(t({ XDG_DATA_HOME: '/h/donnees' })).toBeNull();
    expect(t({ XDG_DATA_HOME: '/h/perso' })).toMatch(/racine XDG inhabituelle/);
  });
  test('n-2 : signatures renforcées — yarn v<n> avec npm-* ou .tmp ; pnpm v<n> avec files ou index', async () => {
    const { cacheSignature } = await import('./families');
    const t: Record<string, string[]> = {
      '/y1': ['v6'], '/y1/v6': ['npm-left-pad-1.3.0-abc'], '/y2': ['v6'], '/y2/v6': ['.tmp'], '/y3': ['v6', 'thesis.docx'], '/y3/v6': ['notes.md'],
      '/p1': ['v10'], '/p1/v10': ['files', 'index'], '/p2': ['v3'], '/p2/v3': ['files'], '/p3': ['v10'], '/p3/v10': ['notes'],
    };
    const l = (p: string) => t[p] ?? null;
    expect(cacheSignature('yarn', '/y1', l)).toBe(true);
    expect(cacheSignature('yarn', '/y2', l)).toBe(true);
    expect(cacheSignature('yarn', '/y3', l)).toBe(false);
    expect(cacheSignature('pnpm', '/p1', l)).toBe(true);
    expect(cacheSignature('pnpm', '/p2', l)).toBe(true);
    expect(cacheSignature('pnpm', '/p3', l)).toBe(false);
  });
});
