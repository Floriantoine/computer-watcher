import { describe, expect, test } from 'vitest';
import {
  OTHERS_SLICE, TEST_PROJECT_SLICE_RE, TEST_SCOPE_RE, TEST_SLICE_RE, isProjectSliceName, isRootSliceName, isScopeName, isTestUnitName,
  newScopeName, projectSliceFor, scopeBelongs, scopePath, shortHash, slicePath, slugOf,
} from './units';

describe('noms d’unités', () => {
  test('slug : dernier composant, minuscules sans accents, [a-z0-9], 40 caractères au plus', () => {
    expect(slugOf('/home/u/alpha')).toBe('alpha');
    expect(slugOf('/home/u/Mon Projet Été/')).toBe('monprojetete');
    expect(slugOf('/home/u/---')).toBe('projet');
    expect(slugOf(`/home/u/${'a'.repeat(60)}`)).toBe('a'.repeat(40));
  });

  test('slice d’un projet, « autres » hors projet, suffixe _hachage seulement en cas de collision', () => {
    const taken = new Map<string, string | null>();
    expect(projectSliceFor('/home/u/alpha', taken)).toBe('cwatch-p-alpha.slice');
    expect(projectSliceFor(null, taken)).toBe(OTHERS_SLICE);
    taken.set('cwatch-p-alpha.slice', '/home/u/alpha');
    expect(projectSliceFor('/home/u/alpha', taken)).toBe('cwatch-p-alpha.slice');
    expect(projectSliceFor('/srv/alpha', taken)).toBe(`cwatch-p-alpha_${shortHash('/srv/alpha')}.slice`);
    expect(projectSliceFor('/home/u/autres', taken)).toBe(`cwatch-p-autres_${shortHash('/home/u/autres')}.slice`);
    expect(projectSliceFor('/home/u/e2etest', taken)).toBe('cwatch-p-e2etest.slice');
    expect(shortHash('/a')).toMatch(/^[0-9a-f]{6}$/);
  });

  test('aucune clé générée ne contient « - » et toutes sont des slices de projet valides', () => {
    const taken = new Map<string, string | null>([['cwatch-p-alpha.slice', '/home/u/alpha']]);
    for (const r of ['/home/u/alpha', '/srv/alpha', `/home/u/${'é'.repeat(80)}x`, '/home/u/Mon-Projet', '/x/autres', '/a/--', null]) {
      const s = projectSliceFor(r, taken);
      expect(s.slice('cwatch-p-'.length, -'.slice'.length), String(r)).not.toContain('-');
      expect(isProjectSliceName(s), s).toBe(true);
    }
  });

  test('scope neuf par lot : cwatch-p-<clé>-<n>.scope', () => {
    expect(newScopeName('cwatch-p-alpha.slice', 'a1')).toBe('cwatch-p-alpha-a1.scope');
    const hashed = `cwatch-p-alpha_${shortHash('/srv/alpha')}.slice`;
    expect(newScopeName(hashed, 'z')).toBe(`cwatch-p-alpha_${shortHash('/srv/alpha')}-z.scope`);
    expect(isScopeName(newScopeName(hashed, 'z'))).toBe(true);
    expect(newScopeName('cwatch-e2eab12-a.slice', '1')).toBe('cwatch-e2eab12-1.scope');
    for (const n of ['', 'A', 'a-b', 'a'.repeat(13), '../x']) expect(() => newScopeName('cwatch-p-alpha.slice', n), n).toThrow();
    expect(() => newScopeName('cwatch.slice', '1')).toThrow();
    expect(() => newScopeName('app.slice', '1')).toThrow();
    expect(scopeBelongs('cwatch-p-alpha-a1.scope', 'cwatch-p-alpha.slice')).toBe(true);
    expect(scopeBelongs('cwatch-p-beta-a1.scope', 'cwatch-p-alpha.slice')).toBe(false);
  });

  test('validation stricte', () => {
    for (const bad of ['cwatch-p-.scope', 'cwatch-p-Alpha-1.scope', 'cwatch-p-../x.scope', 'cwatch-p-a-b-c.scope', 'app.scope', 'cwatch-p-a-1.service', 'cwatch-p-alpha.scope', 42]) {
      expect(isScopeName(bad), String(bad)).toBe(false);
    }
    for (const bad of ['cwatch-p-alpha-xyz.slice', 'cwatch-p-.slice', 'cwatch-p-Alpha.slice', 'cwatch-p.slice', 'app.slice', 'cwatch.slice', 'cwatch-p-a_zzzzzz.slice', 42]) {
      expect(isProjectSliceName(bad), String(bad)).toBe(false);
    }
    expect(isRootSliceName('cwatch.slice')).toBe(true);
    expect(isRootSliceName('cwatch-e2eab12.slice')).toBe(true);
    for (const bad of ['app.slice', 'cwatch-p.slice', 'cwatch-e2e.slice', 'cwatch-e2eAB.slice', 'user.slice', 'cwatch-p-alpha.slice']) expect(isRootSliceName(bad), bad).toBe(false);
  });

  test('chemin : algorithme de systemd, scope sous sa slice de projet', () => {
    expect(slicePath('cwatch.slice')).toBe('cwatch.slice');
    expect(slicePath('cwatch-p-alpha.slice')).toBe('cwatch.slice/cwatch-p.slice/cwatch-p-alpha.slice');
    expect(slicePath('cwatch-e2eab12.slice')).toBe('cwatch.slice/cwatch-e2eab12.slice');
    expect(slicePath('cwatch-e2eab12-a.slice')).toBe('cwatch.slice/cwatch-e2eab12.slice/cwatch-e2eab12-a.slice');
    expect(() => slicePath('app.slice')).toThrow();
    expect(() => slicePath('../x.slice')).toThrow();
    expect(scopePath('cwatch-p-alpha-a1.scope', 'cwatch-p-alpha.slice')).toBe('cwatch.slice/cwatch-p.slice/cwatch-p-alpha.slice/cwatch-p-alpha-a1.scope');
    expect(scopePath('cwatch-e2eab12-1.scope', 'cwatch-e2eab12-a.slice'))
      .toBe('cwatch.slice/cwatch-e2eab12.slice/cwatch-e2eab12-a.slice/cwatch-e2eab12-1.scope');
    expect(() => scopePath('cwatch-p-beta-a1.scope', 'cwatch-p-alpha.slice')).toThrow();
  });

  test('motifs de test : e2e seulement, jamais une unité de projet', () => {
    expect(TEST_SLICE_RE.test('cwatch-e2eab12.slice')).toBe(true);
    expect(TEST_PROJECT_SLICE_RE.test('cwatch-e2eab12-a.slice')).toBe(true);
    expect(TEST_SCOPE_RE.test('cwatch-e2eab12-1.scope')).toBe(true);
    for (const u of ['cwatch.slice', 'cwatch-p-alpha.slice', 'cwatch-p-alpha-a1.scope', 'cwatch-p-e2etest.slice', 'cwatch-p-e2etest-1.scope', 'app.slice']) {
      expect(isTestUnitName(u), u).toBe(false);
    }
    expect(projectSliceFor('/home/u/e2etest', new Map())).toBe('cwatch-p-e2etest.slice');
    expect(isTestUnitName(projectSliceFor('/home/u/e2etest', new Map()))).toBe(false);
  });
});
