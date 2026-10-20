import { describe, expect, test } from 'vitest';
import { OTHERS_SCOPE, isScopeName, isSliceName, scopeNameFor, shortHash, slicePath, slugOf } from './units';

describe('noms d’unités', () => {
  test('slug : dernier composant, minuscules sans accents, [a-z0-9], 40 caractères au plus', () => {
    expect(slugOf('/home/u/alpha')).toBe('alpha');
    expect(slugOf('/home/u/Mon Projet Été/')).toBe('monprojetete');
    expect(slugOf('/home/u/---')).toBe('projet');
    expect(slugOf(`/home/u/${'a'.repeat(60)}`)).toBe('a'.repeat(40));
  });
  test('scope d’un projet, « autres » hors projet, suffixe de hachage seulement en cas de collision', () => {
    const taken = new Map<string, string | null>();
    expect(scopeNameFor('/home/u/alpha', taken)).toBe('cwatch-p-alpha.scope');
    expect(scopeNameFor(null, taken)).toBe(OTHERS_SCOPE);
    taken.set('cwatch-p-alpha.scope', '/home/u/alpha');
    expect(scopeNameFor('/home/u/alpha', taken)).toBe('cwatch-p-alpha.scope');
    expect(scopeNameFor('/srv/alpha', taken)).toBe(`cwatch-p-alpha-${shortHash('/srv/alpha')}.scope`);
    expect(scopeNameFor('/home/u/autres', taken)).toBe(`cwatch-p-autres-${shortHash('/home/u/autres')}.scope`);
    expect(scopeNameFor('/home/u/e2etest', taken)).toBe(`cwatch-p-e2etest-${shortHash('/home/u/e2etest')}.scope`);
    for (const r of ['/home/u/alpha', `/home/u/${'é'.repeat(80)}x`, '/home/u/Mon Projet', '/x/autres']) {
      expect(isScopeName(scopeNameFor(r, taken)), r).toBe(true);
    }
    expect(shortHash('/a')).toMatch(/^[0-9a-f]{6}$/);
  });
  test('validation stricte', () => {
    for (const bad of ['cwatch-p-.scope', 'cwatch-p-Alpha.scope', 'cwatch-p-../x.scope', 'cwatch-p-a b.scope', 'app.scope', 'cwatch-p-a.service', `cwatch-p-${'a'.repeat(49)}.scope`, 42]) {
      expect(isScopeName(bad), String(bad)).toBe(false);
    }
    expect(isSliceName('cwatch.slice')).toBe(true);
    expect(isSliceName('cwatch-e2eab12.slice')).toBe(true);
    for (const bad of ['app.slice', 'cwatch-p.slice', 'cwatch-e2e.slice', 'cwatch-e2eAB.slice', 'user.slice']) expect(isSliceName(bad), bad).toBe(false);
  });
  test('chemin de la slice : un « - » crée une hiérarchie', () => {
    expect(slicePath('cwatch.slice')).toBe('cwatch.slice');
    expect(slicePath('cwatch-e2eab12.slice')).toBe('cwatch.slice/cwatch-e2eab12.slice');
    expect(() => slicePath('app.slice')).toThrow();
  });
});
