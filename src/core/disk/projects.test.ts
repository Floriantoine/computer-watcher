import { describe, expect, test } from 'vitest';
import { DAY_MS, defaultProjectRoots, lastSeenFor, MAX_PROJECT_ROOTS, nodeModulesVerdict, normalizeProjectRoots } from './projects';

describe('normalizeProjectRoots', () => {
  test('chemins absolus normalisés, sans doublon', () => {
    expect(normalizeProjectRoots(['/home/u/projets', '/home/u/projets/', '/home/u/a/../b'])).toEqual(['/home/u/projets', '/home/u/b']);
    expect(normalizeProjectRoots([])).toEqual([]);
  });
  test('refus : relatif, racine, NUL, trop long, pas une liste, trop d’éléments', () => {
    expect(normalizeProjectRoots(['projets'])).toBeNull();
    expect(normalizeProjectRoots(['~/projets'])).toBeNull();
    expect(normalizeProjectRoots(['/'])).toBeNull();
    expect(normalizeProjectRoots(['/a/..'])).toBeNull();
    expect(normalizeProjectRoots(['/a\0b'])).toBeNull();
    expect(normalizeProjectRoots([`/${'x'.repeat(1100)}`])).toBeNull();
    expect(normalizeProjectRoots('/home/u')).toBeNull();
    expect(normalizeProjectRoots([42])).toBeNull();
    expect(normalizeProjectRoots(Array.from({ length: MAX_PROJECT_ROOTS + 1 }, (_, i) => `/p${i}`))).toBeNull();
  });
});

describe('defaultProjectRoots', () => {
  const H = '/home/u';
  const exists = () => true;
  test('parents des racines de projets, sous HOME, jamais HOME ni un dossier caché, sans dossiers imbriqués', () => {
    expect(defaultProjectRoots([`${H}/Delivery/alpha`, `${H}/Delivery/beta`, `${H}/code/gamma`, `${H}/Delivery/alpha/.worktrees/fini`, `${H}/seul`, '/opt/ailleurs/x', `${H}/.cache/outil/y`, `${H}/Delivery/sous/delta`], H, exists))
      .toEqual([`${H}/Delivery`, `${H}/code`]);
  });
  test('dossiers disparus ignorés, au plus MAX_PROJECT_ROOTS', () => {
    expect(defaultProjectRoots([`${H}/a/x`, `${H}/b/y`], H, (p) => p === `${H}/b`)).toEqual([`${H}/b`]);
    expect(defaultProjectRoots(Array.from({ length: 30 }, (_, i) => `${H}/p${String(i).padStart(2, '0')}/x`), H, exists)).toHaveLength(20);
  });
  test('HOME avec un point dans son nom : seuls les segments sous HOME comptent', () => {
    expect(defaultProjectRoots(['/home/a.b/projets/x'], '/home/a.b', exists)).toEqual(['/home/a.b/projets']);
  });
});

describe('lastSeenFor', () => {
  const seen = new Map([['/p/alpha', 100], ['/p/alpha/packages/web', 300], ['/p/beta', 50], ['/p', 10]]);
  test('le projet, ses sous-projets et ses parents comptent ; jamais un voisin', () => {
    expect(lastSeenFor('/p/alpha', seen)).toBe(300);
    expect(lastSeenFor('/p/alphabet', new Map([['/p/alpha', 100]]))).toBeNull();
    expect(lastSeenFor('/p/gamma', seen)).toBe(10);
    expect(lastSeenFor('/q', seen)).toBeNull();
  });
});

describe('nodeModulesVerdict', () => {
  const now = 100 * DAY_MS;
  const base = { lastSeen: null, newestMtime: now - 40 * DAY_MS, historyFrom: now - 60 * DAY_MS, now, days: 30 };
  test('ni processus ni fichier depuis 30 j : inactif', () => {
    expect(nodeModulesVerdict(base)).toEqual({ inactive: true, partialHistory: false });
    expect(nodeModulesVerdict({ ...base, newestMtime: null })).toEqual({ inactive: true, partialHistory: false });
  });
  test('processus vu, fichier récent, budget dépassé : actif', () => {
    expect(nodeModulesVerdict({ ...base, lastSeen: now - 3 * DAY_MS })).toEqual({ inactive: false, reason: 'processus vu il y a 3 j' });
    expect(nodeModulesVerdict({ ...base, newestMtime: now - DAY_MS / 2 })).toEqual({ inactive: false, reason: 'fichier modifié il y a moins de 30 j' });
    expect(nodeModulesVerdict({ ...base, newestMtime: 'budget' })).toEqual({ inactive: false, reason: 'trop de fichiers pour juger' });
  });
  test('historique plus court que le seuil ou absent : jugé quand même, marqué partiel', () => {
    expect(nodeModulesVerdict({ ...base, historyFrom: now - 2 * DAY_MS })).toEqual({ inactive: true, partialHistory: true });
    expect(nodeModulesVerdict({ ...base, historyFrom: null })).toEqual({ inactive: true, partialHistory: true });
  });
});
