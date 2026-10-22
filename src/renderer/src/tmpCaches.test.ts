import { describe, expect, test } from 'vitest';
import type { TmpCache, TmpCaches } from '../../core/tmpCaches';
import { cacheRows, emptyAllAction, showJestAdvice } from './tmpCaches';

const GB = 1024 * 1024;
const c = (o: Partial<TmpCache> & Pick<TmpCache, 'id' | 'name'>): TmpCache => ({ sizeKB: 0, atLeast: false, refusal: null, ...o });
const caches = (...list: TmpCache[]): TmpCaches => ({ root: '/tmp', caches: list });

describe('cacheRows', () => {
  test('libellé, nom, taille (« au moins » si coupée), vidable seulement sans refus et non vide', () => {
    const rows = cacheRows(caches(
      c({ id: 'jest', name: 'jest_rs', sizeKB: 5.3 * GB }),
      c({ id: 'node-compile-cache', name: 'node-compile-cache', sizeKB: 2 * GB, atLeast: true }),
      c({ id: 'v8-compile-cache', name: 'v8-compile-cache-1000', sizeKB: 0 }),
      c({ id: 'playwright-transform-cache', name: 'playwright-transform-cache-1000', refusal: 'lien symbolique (jamais suivi)' }),
    ));
    expect(rows).toEqual([
      { id: 'jest', name: 'jest_rs', label: 'Cache de transformation de Jest', size: '5,3 Go', refusal: null, canEmpty: true },
      { id: 'node-compile-cache', name: 'node-compile-cache', label: 'Cache de compilation de Node.js', size: 'au moins 2,0 Go', refusal: null, canEmpty: true },
      { id: 'v8-compile-cache', name: 'v8-compile-cache-1000', label: 'Cache de compilation (paquet v8-compile-cache)', size: 'vide', refusal: null, canEmpty: false },
      { id: 'playwright-transform-cache', name: 'playwright-transform-cache-1000', label: 'Cache de transformation de Playwright Test', size: '—', refusal: 'lien symbolique (jamais suivi)', canEmpty: false },
    ]);
    expect(cacheRows(null)).toEqual([]);
  });
});

describe('emptyAllAction', () => {
  test('« Tout vider (X) » seulement s’il y a au moins deux caches vidables', () => {
    expect(emptyAllAction(caches(c({ id: 'jest', name: 'jest_rs', sizeKB: GB })))).toBeNull();
    expect(emptyAllAction(caches(c({ id: 'jest', name: 'jest_rs', sizeKB: 5 * GB }), c({ id: 'node-compile-cache', name: 'node-compile-cache', sizeKB: 0.3 * GB }), c({ id: 'v8-compile-cache', name: 'v', sizeKB: GB, refusal: 'autre utilisateur' }))))
      .toEqual({ ids: ['jest', 'node-compile-cache'], label: 'Tout vider (5,3 Go)' });
  });
});

test('conseil cacheDirectory : seulement si le cache Jest est là', () => {
  expect(showJestAdvice(caches(c({ id: 'jest', name: 'jest_rs' })))).toBe(true);
  expect(showJestAdvice(caches(c({ id: 'node-compile-cache', name: 'node-compile-cache' })))).toBe(false);
  expect(showJestAdvice(null)).toBe(false);
});
