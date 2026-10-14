import { describe, expect, test } from 'vitest';
import { MAX_PROJECT_ROOTS, normalizeProjectRoots } from './projects';

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
