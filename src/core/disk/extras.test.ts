import { describe, expect, test } from 'vitest';
import { isDiskCleanRequest, requestFromFamilies } from './extras';

const empty = { families: [], nodeModules: [], worktrees: [], cacheDirs: [], docker: [] };

describe('isDiskCleanRequest', () => {
  test('requêtes valides', () => {
    expect(isDiskCleanRequest(requestFromFamilies(['npm']))).toBe(true);
    expect(isDiskCleanRequest({ ...empty, nodeModules: ['/p/vieux/node_modules'], cacheDirs: ['outil-inconnu'], docker: ['images'] })).toBe(true);
  });
  test('refus : vide, clé inconnue, famille inconnue, doublon, chemin relatif, nom à plusieurs composants, action Docker inconnue, NUL', () => {
    for (const v of [
      empty, null, [], 'npm',
      { ...empty, families: ['npm'], extra: [] },
      { ...empty, families: ['../../etc'] },
      { ...empty, families: ['npm', 'npm'] },
      { ...empty, nodeModules: ['relatif/node_modules'] },
      { ...empty, nodeModules: ['/a', '/a'] },
      { ...empty, worktrees: [42] },
      { ...empty, cacheDirs: ['../.ssh'] },
      { ...empty, cacheDirs: ['..'] },
      { ...empty, docker: ['system'] },
      { ...empty, nodeModules: ['/a\0b'] },
      { families: [], nodeModules: [], worktrees: [], cacheDirs: [] },
    ]) expect(isDiskCleanRequest(v), JSON.stringify(v)).toBe(false);
  });
});
