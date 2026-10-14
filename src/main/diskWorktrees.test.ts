import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { checkWorktree, removeWorktree, scanWorktrees } from './diskProjects';
import { createGitRun } from './gitRun';

// Dépôts temporaires sous ~/.cache/pw-disk2-git-* ; config git de l'utilisateur jamais lue (HOME temporaire)
mkdirSync(join(homedir(), '.cache'), { recursive: true });
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const GIT = existsSync('/usr/bin/git') ? '/usr/bin/git' : '/bin/git';
const DAY = 86_400_000;
const NOW = Date.now();

function repo() {
  const base = realpathSync(mkdtempSync(join(homedir(), '.cache', 'pw-disk2-git-')));
  made.push(base);
  const env = {
    PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const sh = (cwd: string, ...args: string[]) => execFileSync(GIT, args, { cwd, env, encoding: 'utf8' });
  const root = join(base, 'projets');
  const main = join(root, 'alpha');
  mkdirSync(main, { recursive: true });
  sh(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, '.gitignore'), 'node_modules/\n.env\ndist/\nbuild/\n');
  writeFileSync(join(main, 'a.txt'), 'a');
  sh(main, 'add', '.');
  sh(main, 'commit', '-qm', 'init');
  const age = (dir: string, days: number) => {
    const t = new Date(NOW - days * DAY);
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        const st = lstatSync(p);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) walk(p);
        utimesSync(p, t, t);
      }
    };
    walk(dir);
  };
  const wt = (name: string, o: { merged?: boolean; detached?: boolean; aged?: boolean } = {}) => {
    const p = join(main, '.worktrees', name);
    if (o.detached) sh(main, 'worktree', 'add', '-q', '--detach', p);
    else {
      sh(main, 'worktree', 'add', '-q', '-b', name, p);
      writeFileSync(join(p, `${name}.txt`), name);
      sh(p, 'add', '.');
      sh(p, 'commit', '-qm', name);
      if (o.merged) sh(main, 'merge', '-q', '--ff-only', name);
    }
    if (o.aged !== false) age(p, 3);
    return p;
  };
  const git = createGitRun({ env: { PATH: '/usr/bin:/bin', HOME: base } })!;
  return { base, root, main, wt, sh, git, age };
}

const du = async (paths: string[]) => new Map(paths.map((p) => [p, 10]));

describe('scanWorktrees', () => {
  test('fusionné et propre : proposé ; jamais principal, non fusionné, détaché, verrouillé ; refus explicites', async () => {
    const { root, main, wt, sh, git } = repo();
    const fini = wt('fini', { merged: true });
    wt('encours');
    wt('stable-test', { detached: true });
    const garde = wt('garde', { merged: true });
    sh(main, 'worktree', 'lock', garde);
    const sale = wt('sale', { merged: true });
    writeFileSync(join(sale, 'non-suivi.txt'), 'x');
    const secret = wt('secret', { merged: true });
    writeFileSync(join(secret, '.env'), 'JETON=x');
    const deps = wt('deps', { merged: true });
    mkdirSync(join(deps, 'node_modules/x'), { recursive: true });
    writeFileSync(join(deps, 'node_modules/x/index.js'), 'x');
    const r = await scanWorktrees([main], { git, projectRoots: [root], now: NOW, du });
    const by = new Map(r.worktrees.map((c) => [c.path, c]));
    expect([...by.keys()].sort()).toEqual([deps, fini, sale, secret].sort());
    expect(by.get(fini)).toMatchObject({ repo: main, branch: 'fini', refusal: null, sizeKB: 10, label: 'alpha › fini' });
    expect(by.get(deps)!.refusal).toBeNull(); // node_modules ignoré : reconstructible
    expect(by.get(sale)!.refusal).toBe('modifications ou fichiers non suivis');
    expect(by.get(secret)!.refusal).toBe('fichiers ignorés qui seraient perdus : .env');
    expect(r.errors).toEqual([]);
  });
  test('worktree tout juste créé (branche au même commit que main) : refusé « moins de 24 h »', async () => {
    const { root, main, sh, git } = repo();
    const p = join(main, '.worktrees', 'neuf');
    sh(main, 'worktree', 'add', '-q', '-b', 'neuf', p);
    const r = await scanWorktrees([main], { git, projectRoots: [root], now: NOW, du });
    expect(r.worktrees.find((c) => c.path === p)?.refusal).toBe('modifié il y a moins de 24 h');
  });
  test('hors des dossiers de projets : ignoré ; sans branche par défaut : erreur lisible', async () => {
    const { base, main, wt, sh, git } = repo();
    wt('fini', { merged: true });
    expect((await scanWorktrees([main], { git, projectRoots: [join(base, 'autre')], now: NOW, du })).worktrees).toEqual([]);
    sh(main, 'branch', '-m', 'main', 'tronc');
    const r = await scanWorktrees([main], { git, projectRoots: [base], now: NOW, du });
    expect(r.errors[0]).toMatch(/branche par défaut introuvable/);
  });
});

describe('checkWorktree / removeWorktree', () => {
  test('suppression : git worktree remove puis git branch -d ; autres worktrees intacts', async () => {
    const { root, main, wt, sh, git } = repo();
    const fini = wt('fini', { merged: true });
    const encours = wt('encours');
    const [c] = (await scanWorktrees([main], { git, projectRoots: [root], now: NOW, du })).worktrees;
    expect(await checkWorktree(c, { git, projectRoots: [root], now: NOW, dirUser: () => null })).toBeNull();
    expect(await removeWorktree(c, git)).toBeNull();
    expect(existsSync(fini)).toBe(false);
    expect(sh(main, 'branch', '--list', 'fini')).toBe('');
    expect(existsSync(encours)).toBe(true);
    expect(sh(main, 'branch', '--list', 'encours')).toMatch(/encours/);
  });
  test('git branch -d refuse : worktree supprimé, branche gardée, refus rapporté (jamais -D)', async () => {
    const { root, main, wt, sh, git } = repo();
    sh(main, 'branch', 'autre'); // créée avant la fusion
    const fini = wt('fini', { merged: true });
    const [c] = (await scanWorktrees([main], { git, projectRoots: [root], now: NOW, du })).worktrees;
    sh(main, 'checkout', '-q', 'autre'); // HEAD du principal ne contient plus fini
    const note = await removeWorktree(c, git);
    expect(existsSync(fini)).toBe(false);
    expect(note).toMatch(/^worktree supprimé ; branche fini gardée : /);
    expect(sh(main, 'branch', '--list', 'fini')).toMatch(/fini/);
  });
  test('a changé depuis l’analyse (nouveau commit), processus dedans, verrouillé entre-temps : refusé', async () => {
    const { root, main, wt, sh, git, age } = repo();
    const fini = wt('fini', { merged: true });
    const [c] = (await scanWorktrees([main], { git, projectRoots: [root], now: NOW, du })).worktrees;
    const d = { git, projectRoots: [root], now: NOW, dirUser: () => null };
    expect(await checkWorktree(c, { ...d, dirUser: (dir: string) => (dir === fini ? { pid: 4242, name: 'vite' } : null) })).toBe('utilisé par vite (pid 4242)');
    sh(main, 'worktree', 'lock', fini);
    expect(await checkWorktree(c, d)).toBe('verrouillé');
    sh(main, 'worktree', 'unlock', fini);
    writeFileSync(join(fini, 'b.txt'), 'b');
    sh(fini, 'add', '.');
    sh(fini, 'commit', '-qm', 'b');
    age(fini, 3);
    expect(await checkWorktree(c, d)).toBe('a changé depuis l’analyse : actualiser');
  });
  test('fichier non suivi apparu : removeWorktree refuse avant git worktree remove, rien de forcé', async () => {
    const { root, main, wt, git } = repo();
    const fini = wt('fini', { merged: true });
    const [c] = (await scanWorktrees([main], { git, projectRoots: [root], now: NOW, du })).worktrees;
    writeFileSync(join(fini, 'nouveau.txt'), 'x');
    await expect(removeWorktree(c, git)).rejects.toThrow('modifications ou fichiers non suivis');
    expect(existsSync(join(fini, 'nouveau.txt'))).toBe(true);
  });
});

describe('fichiers sensibles dans un dossier ignoré « reconstructible » (I-1, m-3)', () => {
  test('dist/.env ignoré : refusé, le chemin est dans la raison ; dist/ sans fichier sensible : accepté', async () => {
    const { root, main, wt, git, age } = repo();
    const propre = wt('propre', { merged: true });
    mkdirSync(join(propre, 'dist/assets'), { recursive: true });
    writeFileSync(join(propre, 'dist/assets/app.js'), 'x');
    age(propre, 3);
    const secret = wt('secret', { merged: true });
    mkdirSync(join(secret, 'dist/conf'), { recursive: true });
    writeFileSync(join(secret, 'dist/app.js'), 'x');
    writeFileSync(join(secret, 'dist/conf/.env'), 'JETON=x');
    age(secret, 3);
    const r = await scanWorktrees([main], { git, projectRoots: [root], now: NOW, du });
    const by = new Map(r.worktrees.map((c) => [c.path, c]));
    expect(by.get(propre)!.refusal).toBeNull();
    expect(by.get(secret)!.refusal).toBe('fichiers ignorés qui seraient perdus : dist/conf/.env');
  });
  test('clé, base de données, budget dépassé : refusés ; dossier *.asar jamais parcouru', async () => {
    const { root, main, wt, git, age } = repo();
    const cle = wt('cle', { merged: true });
    mkdirSync(join(cle, 'build'), { recursive: true });
    writeFileSync(join(cle, 'build/serveur.pem'), 'x');
    writeFileSync(join(cle, 'build/data.sqlite3'), 'x');
    age(cle, 3);
    const arch = wt('arch', { merged: true });
    mkdirSync(join(arch, 'dist/paquet.asar'), { recursive: true });
    writeFileSync(join(arch, 'dist/paquet.asar/.env'), 'x'); // jamais lu (Electron le verrait comme une archive)
    age(arch, 3);
    const r = await scanWorktrees([main], { git, projectRoots: [root], now: NOW, du });
    const by = new Map(r.worktrees.map((c) => [c.path, c]));
    expect(by.get(cle)!.refusal).toBe('fichiers ignorés qui seraient perdus : build/data.sqlite3, build/serveur.pem');
    expect(by.get(arch)!.refusal).toBeNull();
  });
  test('m-3 : dist/.env apparu après la vérification : removeWorktree refuse, fichier intact', async () => {
    const { root, main, wt, git } = repo();
    const fini = wt('fini', { merged: true });
    const [c] = (await scanWorktrees([main], { git, projectRoots: [root], now: NOW, du })).worktrees;
    expect(await checkWorktree(c, { git, projectRoots: [root], now: NOW, dirUser: () => null })).toBeNull();
    mkdirSync(join(fini, 'dist'), { recursive: true });
    writeFileSync(join(fini, 'dist/.env.local'), 'JETON=x');
    await expect(removeWorktree(c, git)).rejects.toThrow('fichiers ignorés qui seraient perdus : dist/.env.local');
    expect(existsSync(join(fini, 'dist/.env.local'))).toBe(true);
  });
});

describe('filtres git configurés (I-2)', () => {
  const setup = (where: 'local' | 'worktree') => {
    const r = repo();
    writeFileSync(join(r.main, '.gitattributes'), '*.txt filter=x\n');
    r.sh(r.main, 'add', '.');
    r.sh(r.main, 'commit', '-qm', 'attributs'); // filtre pas encore défini : rien n'est exécuté
    const fini = r.wt('fini', { merged: true });
    const marker = join(r.base, 'marqueur');
    const cmd = `touch ${marker}; cat`;
    if (where === 'local') r.sh(r.main, 'config', 'filter.x.clean', cmd);
    else {
      r.sh(r.main, 'config', 'extensions.worktreeConfig', 'true');
      r.sh(fini, 'config', '--worktree', 'filter.x.clean', cmd);
    }
    r.age(fini, 3); // fichiers suivis aux dates changées : git status les relirait par le filtre
    return { ...r, fini, marker };
  };
  for (const where of ['local', 'worktree'] as const) {
    test(`filter.x.clean (config ${where}) : refusé à l’analyse, à la revérification et à la suppression ; jamais exécuté`, async () => {
      const { root, main, git, fini, marker } = setup(where);
      const r = await scanWorktrees([main], { git, projectRoots: [root], now: NOW, du });
      const c = r.worktrees.find((x) => x.path === fini)!;
      expect(c.refusal).toBe('filtre git configuré : vérifie à la main');
      expect(await checkWorktree(c, { git, projectRoots: [root], now: NOW, dirUser: () => null })).toBe('filtre git configuré : vérifie à la main');
      await expect(removeWorktree(c, git)).rejects.toThrow('filtre git configuré : vérifie à la main');
      expect(existsSync(fini)).toBe(true);
      expect(existsSync(marker)).toBe(false);
    });
  }
});

describe('échéance globale de scanWorktrees (m-4)', () => {
  test('au-delà : arrêt, le reste n’est pas proposé, « analyse interrompue : trop long »', async () => {
    const { root, main, wt, git } = repo();
    wt('fini', { merged: true });
    let t = 0;
    const r = await scanWorktrees([main], { git, projectRoots: [root], now: NOW, du, deadlineMs: 1000, clock: () => (t += 5000) });
    expect(r.worktrees).toEqual([]);
    expect(r.errors).toEqual(['worktrees : analyse interrompue : trop long']);
  });
});
