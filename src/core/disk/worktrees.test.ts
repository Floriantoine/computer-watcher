import { describe, expect, test } from 'vitest';
import { defaultBranchFrom, isSafeBranchName, parseStatusZ, parseWorktreeList, statusRefusal, worktreeExclusion } from './worktrees';

const LIST = [
  'worktree /p/alpha', 'HEAD aaa', 'branch refs/heads/main', '',
  'worktree /p/alpha/.worktrees/fini', 'HEAD bbb', 'branch refs/heads/fini', '',
  'worktree /p/alpha/.worktrees/stable', 'HEAD ccc', 'detached', '',
  'worktree /p/alpha/.worktrees/garde', 'HEAD ddd', 'branch refs/heads/garde', 'locked en cours d’usage', '',
  'worktree /p/alpha/.worktrees/perdu', 'HEAD eee', 'branch refs/heads/perdu', 'prunable gitdir file points to non-existent location', '',
  'worktree /p/alpha/.worktrees/a espace', 'HEAD fff', 'branch refs/heads/feat/x', '',
].join('\0');

describe('parseWorktreeList', () => {
  test('entrées, attributs, chemins avec espace', () => {
    const l = parseWorktreeList(LIST);
    expect(l.map((e) => e.path)).toEqual(['/p/alpha', '/p/alpha/.worktrees/fini', '/p/alpha/.worktrees/stable', '/p/alpha/.worktrees/garde', '/p/alpha/.worktrees/perdu', '/p/alpha/.worktrees/a espace']);
    expect(l[1]).toEqual({ path: '/p/alpha/.worktrees/fini', head: 'bbb', branch: 'fini', bare: false, detached: false, locked: false, prunable: false });
    expect(l[2].detached).toBe(true);
    expect(l[3].locked).toBe(true);
    expect(l[4].prunable).toBe(true);
    expect(l[5].branch).toBe('feat/x');
  });
  test('sortie vide ou tronquée : pas d’exception', () => {
    expect(parseWorktreeList('')).toEqual([]);
    expect(parseWorktreeList('HEAD x\0')).toEqual([]);
  });
});

describe('worktreeExclusion (décisions « 1a »)', () => {
  const l = parseWorktreeList(LIST);
  test('jamais : principal, détaché, verrouillé, à élaguer, branche par défaut', () => {
    expect(worktreeExclusion(l[0], 0, 'main')).toBe('worktree principal');
    expect(worktreeExclusion(l[1], 1, 'main')).toBeNull();
    expect(worktreeExclusion(l[2], 2, 'main')).toBe('détaché (sans branche)');
    expect(worktreeExclusion(l[3], 3, 'main')).toBe('verrouillé');
    expect(worktreeExclusion(l[4], 4, 'main')).toBe('à élaguer (prunable)');
    expect(worktreeExclusion({ ...l[1], branch: 'main' }, 1, 'main')).toBe('branche par défaut');
    expect(worktreeExclusion({ ...l[1], bare: true }, 1, 'main')).toBe('dépôt nu');
    expect(worktreeExclusion({ ...l[1], branch: '-D' }, 1, 'main')).toBe('nom de branche inhabituel');
  });
});

describe('isSafeBranchName', () => {
  test('noms de branche ordinaires seulement', () => {
    for (const b of ['fini', 'feat/disk-page-lot2', 'v1.2_x']) expect(isSafeBranchName(b), b).toBe(true);
    for (const b of ['', '-D', '--force', 'a..b', 'a//b', 'a/', 'x.lock', 'a b', 'é', 'a\nb', 'x'.repeat(201)]) expect(isSafeBranchName(b), JSON.stringify(b)).toBe(false);
  });
});

describe('defaultBranchFrom', () => {
  test('origin/HEAD d’abord, sinon main, sinon master, sinon rien', () => {
    expect(defaultBranchFrom('origin/develop', ['main'])).toEqual({ ref: 'refs/remotes/origin/develop', name: 'develop' });
    expect(defaultBranchFrom(null, ['master', 'main'])).toEqual({ ref: 'refs/heads/main', name: 'main' });
    expect(defaultBranchFrom(null, ['master'])).toEqual({ ref: 'refs/heads/master', name: 'master' });
    expect(defaultBranchFrom(null, [])).toBeNull();
    expect(defaultBranchFrom('origin/-x', [])).toBeNull();
  });
});

describe('statut', () => {
  test('parseStatusZ : renommage (deux chemins), ignorés', () => {
    expect(parseStatusZ('R  nouveau.txt\0ancien.txt\0?? neuf.txt\0!! node_modules/\0')).toEqual([
      { code: 'R ', path: 'nouveau.txt' }, { code: '??', path: 'neuf.txt' }, { code: '!!', path: 'node_modules/' },
    ]);
  });
  test('statusRefusal : propre, ignorés reconstructibles seulement → null', () => {
    expect(statusRefusal([])).toBeNull();
    expect(statusRefusal(parseStatusZ('!! node_modules/\0!! packages/web/dist/\0!! tsconfig.tsbuildinfo\0!! src/__pycache__/\0'))).toBeNull();
  });
  test('statusRefusal : modification ou fichier non suivi', () => {
    expect(statusRefusal(parseStatusZ(' M a.txt\0'))).toBe('modifications ou fichiers non suivis');
    expect(statusRefusal(parseStatusZ('?? neuf.txt\0'))).toBe('modifications ou fichiers non suivis');
  });
  test('statusRefusal : fichiers ignorés à garder (.env, données) → refus qui les nomme', () => {
    expect(statusRefusal(parseStatusZ('!! node_modules/\0!! .env\0!! donnees/\0'))).toBe('fichiers ignorés qui seraient perdus : .env, donnees/');
    const many = Array.from({ length: 8 }, (_, i) => `!! f${i}.local`).join('\0') + '\0';
    expect(statusRefusal(parseStatusZ(many))).toBe('fichiers ignorés qui seraient perdus : f0.local, f1.local, f2.local, f3.local, f4.local et 3 autres');
  });
});
