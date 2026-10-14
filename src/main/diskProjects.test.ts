import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import type { NodeModulesCandidate } from '../core/disk/extras';
import { checkNodeModules, findProjectDirs, newestMtime, realProjectRoots, removeNodeModules, scanNodeModules } from './diskProjects';
import { removeTreeSafe } from './safeFs';

// Dossiers temporaires sous ~/.cache/pw-disk2-* (jamais les vrais dépôts de l'utilisateur)
mkdirSync(join(homedir(), '.cache'), { recursive: true });
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const DAY = 86_400_000;
const NOW = Date.now();

function tree() {
  const base = realpathSync(mkdtempSync(join(homedir(), '.cache', 'pw-disk2-proj-')));
  made.push(base);
  const root = join(base, 'projets');
  const put = (p: string, ageDays = 40) => {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, 'x');
    const t = new Date(NOW - ageDays * DAY);
    utimesSync(p, t, t);
  };
  put(join(root, 'vieux/package.json'));
  put(join(root, 'vieux/src/index.ts'));
  put(join(root, 'vieux/node_modules/dep/index.js'));
  put(join(root, 'vieux/node_modules/dep/node_modules/sous/package.json')); // jamais listé à part
  put(join(root, 'vieux/node_modules/electron/dist/resources/default_app.asar')); // archive Electron : un fichier comme un autre
  put(join(root, 'recent/package.json'));
  put(join(root, 'recent/src/app.ts'), 1);
  put(join(root, 'recent/node_modules/dep/index.js'));
  put(join(root, 'sans-package/node_modules/dep/index.js')); // pas de package.json voisin : ignoré
  put(join(root, '.cache-outil/projet/package.json')); // dossier caché : jamais parcouru
  put(join(root, '.cache-outil/projet/node_modules/x.js'));
  put(join(root, 'mono/.worktrees/branche/package.json')); // .worktrees : parcouru
  put(join(root, 'mono/.worktrees/branche/node_modules/x.js'));
  symlinkSync('/', join(root, 'lien-racine')); // jamais suivi
  put(join(base, 'ailleurs/package.json'));
  put(join(base, 'ailleurs/node_modules/x.js'));
  symlinkSync(join(base, 'ailleurs'), join(root, 'lien-projet')); // projet en lien : jamais suivi
  put(join(root, 'pnpm-like/package.json'));
  symlinkSync(join(base, 'ailleurs/node_modules'), join(root, 'pnpm-like/node_modules')); // node_modules en lien : jamais proposé
  return { base, root, put };
}

const cand = (root: string): NodeModulesCandidate => ({ path: join(root, 'vieux/node_modules'), projectDir: join(root, 'vieux'), label: 'vieux', sizeKB: 1, lastSeen: null, partialHistory: false });
const checkDeps = (root: string) => ({
  projectRoots: [root], mountinfo: () => '', dirUser: () => null, seen: new Map<string, number>(), historyFrom: NOW - 60 * DAY, now: NOW, days: 30,
});

describe('findProjectDirs', () => {
  test('node_modules avec package.json voisin ; jamais à travers un lien ni dans un dossier caché (sauf .worktrees)', async () => {
    const { root } = tree();
    const r = await findProjectDirs([root]);
    expect(r.nodeModules.sort()).toEqual([join(root, 'mono/.worktrees/branche/node_modules'), join(root, 'recent/node_modules'), join(root, 'vieux/node_modules')]);
    expect(r.truncated).toBe(false);
  });
  test('budget de dossiers : incomplet', async () => {
    const { root } = tree();
    expect((await findProjectDirs([root], { maxDirs: 2 })).truncated).toBe(true);
  });
  test('racines en double ou imbriquées : un seul passage', async () => {
    const { root } = tree();
    const r = await findProjectDirs([root, join(root, 'vieux'), root]);
    expect(r.nodeModules.filter((p) => p.endsWith('/vieux/node_modules'))).toHaveLength(1);
  });
  test('racine en lien symbolique : résolue (chemin réel) ; racine absente : ignorée', async () => {
    const { base, root } = tree();
    symlinkSync(root, join(base, 'raccourci'));
    const r = await findProjectDirs([join(base, 'raccourci'), join(base, 'absent')]);
    expect(r.nodeModules).toContain(join(root, 'vieux/node_modules'));
  });
  test('dépôts git : dossier .git réel seulement (un worktree a un fichier .git)', async () => {
    const { root } = tree();
    mkdirSync(join(root, 'depot/.git'), { recursive: true });
    mkdirSync(join(root, 'wt'), { recursive: true });
    writeFileSync(join(root, 'wt/.git'), 'gitdir: /ailleurs\n');
    expect((await findProjectDirs([root])).repos).toEqual([join(root, 'depot')]);
  });
});

describe('newestMtime', () => {
  test('fichier récent hors dossiers ignorés : trouvé ; node_modules et .git ignorés', async () => {
    const { root, put } = tree();
    const since = NOW - 30 * DAY;
    expect(await newestMtime(join(root, 'vieux'), { since })).toBeLessThan(since);
    put(join(root, 'vieux/node_modules/dep/neuf.js'), 0);
    put(join(root, 'vieux/.git/index'), 0);
    expect(await newestMtime(join(root, 'vieux'), { since })).toBeLessThan(since);
    put(join(root, 'vieux/src/neuf.ts'), 0);
    expect(await newestMtime(join(root, 'vieux'), { since })).toBeGreaterThanOrEqual(since);
  });
  test('budget d’entrées dépassé sans fichier récent : « budget »', async () => {
    const { root } = tree();
    expect(await newestMtime(join(root, 'vieux'), { since: NOW - 30 * DAY, maxEntries: 1 })).toBe('budget');
  });
});

describe('scanNodeModules', () => {
  const du = async (paths: string[]) => new Map(paths.map((p) => [p, 1234]));
  test('inactifs seulement, taille par du, projet = racine du projet', async () => {
    const { root } = tree();
    const { nodeModules } = await findProjectDirs([root]);
    const { nodeModules: r, errors } = await scanNodeModules(nodeModules, { home: homedir(), seen: new Map(), historyFrom: NOW - 60 * DAY, now: NOW, days: 30, du });
    expect(errors).toEqual([]);
    expect(r.map((c) => c.path).sort()).toEqual([join(root, 'mono/.worktrees/branche/node_modules'), join(root, 'vieux/node_modules')]);
    expect(r.find((c) => c.path.endsWith('/vieux/node_modules'))).toMatchObject({ sizeKB: 1234, partialHistory: false, projectDir: join(root, 'vieux'), lastSeen: null });
  });
  test('processus vu dans le projet il y a 3 jours : pas proposé', async () => {
    const { root } = tree();
    const { nodeModules } = await findProjectDirs([root]);
    const { nodeModules: r } = await scanNodeModules(nodeModules, { home: homedir(), seen: new Map([[join(root, 'vieux'), NOW - 3 * DAY]]), historyFrom: NOW - 60 * DAY, now: NOW, days: 30, du });
    expect(r.map((c) => c.path)).not.toContain(join(root, 'vieux/node_modules'));
  });
  test('historique plus court que le seuil : proposé, marqué partiel', async () => {
    const { root } = tree();
    const { nodeModules } = await findProjectDirs([root]);
    const { nodeModules: r } = await scanNodeModules(nodeModules, { home: homedir(), seen: new Map(), historyFrom: NOW - 2 * DAY, now: NOW, days: 30, du });
    expect(r.every((c) => c.partialHistory)).toBe(true);
  });
});

describe('scanNodeModules : échéance et plafond (m-4)', () => {
  const du = async (paths: string[]) => new Map(paths.map((p) => [p, 1]));
  test('échéance dépassée : arrêt, rien de plus proposé, « analyse interrompue : trop long »', async () => {
    const { root } = tree();
    const { nodeModules } = await findProjectDirs([root]);
    let t = 0;
    const r = await scanNodeModules(nodeModules, { home: homedir(), seen: new Map(), historyFrom: NOW - 60 * DAY, now: NOW, days: 30, du, deadlineMs: 1000, clock: () => (t += 5000) });
    expect(r).toEqual({ nodeModules: [], errors: ['node_modules : analyse interrompue : trop long'] });
  });
  test('plus de projets que le plafond : les premiers seulement, arrêt signalé', async () => {
    const { root } = tree();
    const { nodeModules } = await findProjectDirs([root]);
    const r = await scanNodeModules(nodeModules, { home: homedir(), seen: new Map(), historyFrom: NOW - 60 * DAY, now: NOW, days: 30, du, maxProjects: 1 });
    expect(r.nodeModules.map((c) => c.path)).toEqual([join(root, 'mono/.worktrees/branche/node_modules')]); // premier dans l'ordre du parcours
    expect(r.errors).toEqual(['node_modules : analyse interrompue : plus de 1 projets']);
  });
});

describe('realProjectRoots (m-6)', () => {
  test('défaut : jamais HOME, un de ses parents, « / » ni un dossier caché, même via un lien ; réglage : seulement jamais « / »', () => {
    const { base, root } = tree();
    const home = join(base, 'maison');
    mkdirSync(join(home, '.cache/projets'), { recursive: true });
    mkdirSync(join(home, 'Projets'), { recursive: true });
    symlinkSync(home, join(home, 'Projets/vers-home'));
    symlinkSync('/', join(home, 'Projets/vers-racine'));
    symlinkSync(join(home, '.cache/projets'), join(home, 'Projets/vers-cache'));
    symlinkSync(base, join(home, 'Projets/vers-parent'));
    const links = ['vers-home', 'vers-racine', 'vers-cache', 'vers-parent'].map((n) => join(home, 'Projets', n));
    // root est sous ~/.cache (dossier caché hors de HOME) : écarté aussi
    expect(realProjectRoots([join(home, 'Projets'), root, ...links], { home, isDefault: true })).toEqual([join(home, 'Projets')]);
    expect(realProjectRoots([...links], { home, isDefault: false })).toEqual([home, join(home, '.cache/projets'), base]);
  });
});

describe('checkNodeModules / removeNodeModules', () => {
  test('rien n’a changé : supprimable', async () => {
    const { root } = tree();
    expect(await checkNodeModules(cand(root), checkDeps(root))).toBeNull();
  });
  test('processus dans le projet : « utilisé par … »', async () => {
    const { root } = tree();
    const d = { ...checkDeps(root), dirUser: (dir: string) => (dir === join(root, 'vieux') ? { pid: 4242, name: 'node' } : null) };
    expect(await checkNodeModules(cand(root), d)).toBe('utilisé par node (pid 4242)');
  });
  test('fichier source modifié depuis l’analyse : refusé', async () => {
    const { root, put } = tree();
    put(join(root, 'vieux/src/neuf.ts'), 0);
    expect(await checkNodeModules(cand(root), checkDeps(root))).toMatch(/^plus inactif : fichier modifié/);
  });
  test('node_modules remplacé par un lien entre l’analyse et la suppression : refusé, cible intacte', async () => {
    const { base, root } = tree();
    rmSync(join(root, 'vieux/node_modules'), { recursive: true });
    symlinkSync(join(base, 'ailleurs/node_modules'), join(root, 'vieux/node_modules'));
    expect(await checkNodeModules(cand(root), checkDeps(root))).toMatch(/lien symbolique/);
    expect(() => removeNodeModules(cand(root), { projectRoots: [root], mountinfo: () => '' })).toThrow(/lien symbolique/);
    expect(existsSync(join(base, 'ailleurs/node_modules/x.js'))).toBe(true);
  });
  test('hors des dossiers de projets, ou point de montage dessous : refusé', async () => {
    const { root } = tree();
    expect(await checkNodeModules(cand(root), { ...checkDeps(root), projectRoots: [join(root, 'autre')] })).toBe('hors des dossiers de projets');
    const mi = `36 35 0:40 / ${join(root, 'vieux/node_modules/dep')} rw - ext4 /dev/sdb1 rw\n`;
    expect(await checkNodeModules(cand(root), { ...checkDeps(root), mountinfo: () => mi })).toMatch(/point de montage/);
  });
  test('suppression sous noAsar (archives .asar comprises), voisins intacts, noAsar rétabli', () => {
    const { root } = tree();
    let during: unknown;
    removeNodeModules(cand(root), {
      projectRoots: [root], mountinfo: () => '',
      remove: (roots, p, o) => {
        during = (process as unknown as { noAsar?: boolean }).noAsar;
        return removeTreeSafe(roots, p, o);
      },
    });
    expect(during).toBe(true);
    expect(existsSync(join(root, 'vieux/node_modules'))).toBe(false);
    expect(existsSync(join(root, 'vieux/package.json'))).toBe(true);
    expect((process as unknown as { noAsar?: boolean }).noAsar).toBeUndefined();
  });
});

describe('liens posés entre l’analyse et la suppression, archives .asar', () => {
  test('projet remplacé par un lien : refusé, cible intacte', async () => {
    const { base, root, put } = tree();
    put(join(base, 'cible/package.json'));
    put(join(base, 'cible/node_modules/garde.js'));
    rmSync(join(root, 'vieux'), { recursive: true });
    symlinkSync(join(base, 'cible'), join(root, 'vieux'));
    expect(await checkNodeModules(cand(root), checkDeps(root))).toMatch(/lien symbolique/);
    expect(() => removeNodeModules(cand(root), { projectRoots: [root], mountinfo: () => '' })).toThrow(/lien symbolique/);
    expect(existsSync(join(base, 'cible/node_modules/garde.js'))).toBe(true);
  });
  test('racine de projets remplacée par un lien : refusé, cible intacte', async () => {
    const { base, root, put } = tree();
    put(join(base, 'copie/vieux/package.json'));
    put(join(base, 'copie/vieux/node_modules/garde.js'));
    rmSync(root, { recursive: true });
    symlinkSync(join(base, 'copie'), root);
    expect(await checkNodeModules(cand(root), checkDeps(root))).toMatch(/lien symbolique/);
    expect(() => removeNodeModules(cand(root), { projectRoots: [root], mountinfo: () => '' })).toThrow(/lien symbolique/);
    expect(existsSync(join(base, 'copie/vieux/node_modules/garde.js'))).toBe(true);
  });
  test('chemin hors racine ou qui n’est pas un node_modules : jamais supprimé', () => {
    const { root } = tree();
    expect(() => removeNodeModules({ ...cand(root), path: join(root, 'vieux/src') }, { projectRoots: [root], mountinfo: () => '' })).toThrow(/chemin refusé/);
    expect(() => removeNodeModules(cand(root), { projectRoots: [join(root, 'autre')], mountinfo: () => '' })).toThrow(/hors des dossiers/);
    expect(existsSync(join(root, 'vieux/node_modules/dep/index.js'))).toBe(true);
  });
  test('dossier nommé *.asar : jamais parcouru (Electron le lirait comme une archive)', async () => {
    const { root, put } = tree();
    put(join(root, 'paquet.asar/projet/package.json'));
    put(join(root, 'paquet.asar/projet/node_modules/x.js'));
    const r = await findProjectDirs([root]);
    expect(r.nodeModules.some((p) => p.includes('.asar'))).toBe(false);
    expect(await findProjectDirs([join(root, 'paquet.asar')])).toEqual({ nodeModules: [], repos: [], truncated: false });
    expect(await checkNodeModules({ ...cand(root), path: join(root, 'paquet.asar/projet/node_modules') }, checkDeps(root))).toBe('chemin refusé');
  });
});
