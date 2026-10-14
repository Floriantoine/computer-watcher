import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { requestFromFamilies, type DiskCleanRequest } from '../core/disk/extras';
import type { FamilyRoots } from '../core/disk/families';
import { buildUnits, cleanDisk, diskCleanAllEvent, EMPTY_EXTRAS, type CleanUnit, type UnitDeps } from './diskCleanAll';
import type { CleanDeps } from './diskClean';

mkdirSync(join(homedir(), '.cache'), { recursive: true });
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const DAY = 86_400_000;
const NOW = Date.now();
const empty: DiskCleanRequest = { families: [], nodeModules: [], worktrees: [], cacheDirs: [], docker: [] };

function fakeHome() {
  const base = realpathSync(mkdtempSync(join(homedir(), '.cache', 'pw-disk2-all-')));
  made.push(base);
  const home = join(base, 'home');
  const roots: FamilyRoots = { home, configHome: join(home, '.config'), dataHome: join(home, '.local/share'), cacheHome: join(home, '.cache') };
  const put = (p: string, ageDays = 40) => {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, 'x');
    const t = new Date(NOW - ageDays * DAY);
    utimesSync(p, t, t);
  };
  put(join(home, '.npm/_cacache/index-v5/aa/b'));
  put(join(home, 'projets/vieux/package.json'));
  put(join(home, 'projets/vieux/node_modules/dep/index.js'));
  put(join(home, 'projets/actif/package.json'));
  put(join(home, 'projets/actif/node_modules/dep/index.js'));
  return { base, home, roots };
}

function famDeps(roots: FamilyRoots, o: Partial<CleanDeps> = {}) {
  let avail = 5000;
  const asked: { message: string; detail: string }[] = [];
  const d: CleanDeps = {
    roots, confirm: async (s) => (asked.push(s), true), dirUser: () => null, procByName: () => null,
    statfs: () => ({ availKB: (avail += 1000) }), runRoot: async () => ({ ok: true, cancelled: false }), mountinfo: () => '',
    sizes: { npm: 2048 }, rootUnavailable: () => null, ...o,
  };
  return { d, asked };
}

/** Unité factice : vérifications et actions scriptées. */
function unit(id: string, o: Partial<CleanUnit> & { checks?: (string | null)[] } = {}) {
  const ran: string[] = [];
  const checks = [...(o.checks ?? [null, null])];
  const u: CleanUnit = {
    id, label: `élément ${id}`, estimatedKB: 100, detail: () => [`détail ${id}`],
    check: async () => (checks.length ? checks.shift()! : null),
    run: async () => (ran.push(id), null),
    ...o,
  };
  return { u, ran };
}

describe('cleanDisk', () => {
  test('familles et unités : une seule confirmation (chemins, détails, refus, définitif), tout exécuté', async () => {
    const { home, roots } = fakeHome();
    const { d, asked } = famDeps(roots);
    const a = unit('cache:outil');
    const b = unit('docker:images', { checks: ['Docker ne répond plus'] });
    const r = await cleanDisk({ ...empty, families: ['npm'], cacheDirs: ['outil'], docker: ['images'] }, { fam: d, units: [a.u, b.u] });
    expect(asked).toHaveLength(1);
    expect(asked[0].message).toBe('Libérer ≈ 2 Mo ?');
    expect(asked[0].detail).toMatch(/Cache npm[\s\S]*élément cache:outil — ≈ 100 Ko\n    détail cache:outil[\s\S]*Refusé : élément docker:images — Docker ne répond plus[\s\S]*définitif/);
    expect(r.done).toEqual(['npm', 'cache:outil']);
    expect(r.refused).toEqual([{ id: 'docker:images', label: 'élément docker:images', reason: 'Docker ne répond plus' }]);
    expect(a.ran).toEqual(['cache:outil']);
    expect(b.ran).toEqual([]);
    expect(existsSync(join(home, '.npm/_cacache'))).toBe(false);
    expect(r.freedKB).toBe(1000);
    expect(r.estimatedKB).toBe(2048 + 100);
  });
  test('revérification juste avant d’agir : refus, rien exécuté pour cet élément', async () => {
    const { roots } = fakeHome();
    const a = unit('cache:x', { checks: [null, 'utilisé par outil (pid 7)'] });
    const r = await cleanDisk({ ...empty, cacheDirs: ['x'] }, { fam: famDeps(roots).d, units: [a.u] });
    expect(a.ran).toEqual([]);
    expect(r.refused).toEqual([{ id: 'cache:x', label: 'élément cache:x', reason: 'utilisé par outil (pid 7)' }]);
  });
  test('échec pendant l’action : refusé « arrêté », les suivants continuent ; note rapportée', async () => {
    const { roots } = fakeHome();
    const a = unit('worktree:/p/a', { run: async () => { throw new Error('git a refusé de supprimer le worktree : x'); } });
    const b = unit('worktree:/p/b', { run: async () => 'worktree supprimé ; branche b gardée : y' });
    const r = await cleanDisk({ ...empty, worktrees: ['/p/a', '/p/b'] }, { fam: famDeps(roots).d, units: [a.u, b.u] });
    expect(r.refused[0].reason).toBe('git a refusé de supprimer le worktree : x (arrêté ; une partie a pu être supprimée)');
    expect(r.done).toEqual(['worktree:/p/b']);
    expect(r.notes).toEqual([{ id: 'worktree:/p/b', label: 'élément worktree:/p/b', note: 'worktree supprimé ; branche b gardée : y' }]);
  });
  test('annulé : rien exécuté ; tout refusé d’avance : pas de confirmation', async () => {
    const { roots } = fakeHome();
    const a = unit('cache:x');
    const r = await cleanDisk({ ...empty, cacheDirs: ['x'] }, { fam: famDeps(roots, { confirm: async () => false }).d, units: [a.u] });
    expect(r.cancelled).toBe(true);
    expect(a.ran).toEqual([]);
    const { d, asked } = famDeps(roots);
    const r2 = await cleanDisk({ ...empty, cacheDirs: ['x'] }, { fam: d, units: [unit('cache:x', { checks: ['introuvable'] }).u] });
    expect(asked).toHaveLength(0);
    expect(r2).toMatchObject({ done: [], cancelled: false });
  });
  test('événement disk_clean : clés des éléments ; rien si annulé', () => {
    expect(diskCleanAllEvent({ freedKB: 5, done: ['npm', 'cache:x'], refused: [{ id: 'docker:images', label: 'l', reason: 'r' }], notes: [], cancelled: false }, 9))
      .toEqual({ ts: 9, type: 'disk_clean', groupKey: null, detail: { freedKB: 5, done: ['npm', 'cache:x'], refused: [{ id: 'docker:images', reason: 'r' }] } });
    expect(diskCleanAllEvent({ freedKB: 0, done: [], refused: [], notes: [], cancelled: true }, 9)).toBeNull();
  });
});

describe('buildUnits', () => {
  const unitDeps = (roots: FamilyRoots, projectRoots: string[]): UnitDeps => ({
    roots, projectRoots, mountinfo: () => '', dirUser: () => null, git: null, docker: null, now: () => NOW, days: 30, seen: () => new Map(), historyFrom: () => NOW - 60 * DAY,
  });
  test('un chemin envoyé par le renderer mais absent de la dernière analyse : refusé, jamais touché', async () => {
    const { home, roots } = fakeHome();
    const forged = join(home, 'projets/actif/node_modules');
    const units = buildUnits({ ...empty, nodeModules: [forged], worktrees: ['/p/x'], cacheDirs: ['outil'], docker: ['images'] }, EMPTY_EXTRAS, unitDeps(roots, [join(home, 'projets')]));
    const r = await cleanDisk({ ...empty, nodeModules: [forged], worktrees: ['/p/x'], cacheDirs: ['outil'], docker: ['images'] }, { fam: famDeps(roots).d, units });
    expect(r.done).toEqual([]);
    expect(r.refused.map((x) => x.reason)).toEqual(['plus dans la liste : actualiser la page', 'git introuvable', 'plus dans la liste : actualiser la page', 'Docker indisponible']);
    expect(existsSync(join(forged, 'dep/index.js'))).toBe(true);
  });
  test('node_modules de la dernière analyse et famille npm : une confirmation, les deux supprimés, package.json gardé', async () => {
    const { home, roots } = fakeHome();
    const nm = join(home, 'projets/vieux/node_modules');
    const c = { path: nm, projectDir: join(home, 'projets/vieux'), label: 'projets / vieux', sizeKB: 4, lastSeen: null, partialHistory: false };
    const state = { ...EMPTY_EXTRAS, nodeModules: new Map([[nm, c]]) };
    const req = { ...empty, families: ['npm' as const], nodeModules: [nm] };
    const { d, asked } = famDeps(roots);
    const r = await cleanDisk(req, { fam: d, units: buildUnits(req, state, unitDeps(roots, [join(home, 'projets')])) });
    expect(asked).toHaveLength(1);
    expect(asked[0].detail).toContain(`node_modules de projets / vieux — ≈ 4 Ko\n    ${nm}`);
    expect(r.done).toEqual(['npm', `node_modules:${nm}`]);
    expect(existsSync(nm)).toBe(false);
    expect(existsSync(join(home, 'projets/vieux/package.json'))).toBe(true);
  });
  test('requête de familles du lot 1 (tableau) : même résultat qu’avant', async () => {
    const { roots } = fakeHome();
    const r = await cleanDisk(requestFromFamilies(['npm']), { fam: famDeps(roots).d, units: [] });
    expect(r.done).toEqual(['npm']);
  });
});
