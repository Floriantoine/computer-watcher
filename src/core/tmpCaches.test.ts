import { describe, expect, test } from 'vitest';
import {
  CACHE_OFFER_MIN_KB, cachesOffer, cachesOutcomeMessage, isTmpCacheIds, TMP_CACHE_IDS, tmpCacheName, tmpCachesEvent,
  type TmpCache, type TmpCachesOutcome,
} from './tmpCaches';

const GB = 1024 * 1024;
const cache = (o: Partial<TmpCache> & Pick<TmpCache, 'id'>): TmpCache => ({ name: tmpCacheName(o.id, 1000), sizeKB: 0, atLeast: false, refusal: null, ...o });

describe('noms figés', () => {
  test('uid 1000 : jest_rs (uid en base 36), node-compile-cache, v8-compile-cache-1000, playwright-transform-cache-1000', () => {
    expect(TMP_CACHE_IDS.map((id) => tmpCacheName(id, 1000))).toEqual(['jest_rs', 'node-compile-cache', 'v8-compile-cache-1000', 'playwright-transform-cache-1000']);
    expect(tmpCacheName('jest', 1001)).toBe('jest_rt');
    expect(tmpCacheName('jest', 0)).toBe('jest_0');
  });
});

describe('isTmpCacheIds (requête du renderer)', () => {
  test('1 à 4 identifiants connus, distincts', () => {
    expect(isTmpCacheIds(['jest'])).toBe(true);
    expect(isTmpCacheIds([...TMP_CACHE_IDS])).toBe(true);
  });
  test('tout le reste est refusé : vide, doublon, inconnu, chemin, autre type', () => {
    for (const bad of [[], ['jest', 'jest'], ['tsx'], ['../jest_rs'], ['/tmp/jest_rs'], 'jest', null, [1], [...TMP_CACHE_IDS, 'jest']]) expect(isTmpCacheIds(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe('cachesOffer (alerte, notification)', () => {
  test('rien, ou moins de 100 Mo vidables : pas de bouton', () => {
    expect(cachesOffer(null)).toBeNull();
    expect(cachesOffer({ root: '/tmp', caches: [] })).toBeNull();
    expect(cachesOffer({ root: '/tmp', caches: [cache({ id: 'jest', sizeKB: CACHE_OFFER_MIN_KB - 1 })] })).toBeNull();
    expect(cachesOffer({ root: '/tmp', caches: [cache({ id: 'jest', sizeKB: 5 * GB, refusal: 'autre utilisateur' })] })).toBeNull();
  });
  test('un seul cache : « Vider le cache Jest (5,3 Go) » ; plusieurs : « Vider les caches (…) », seulement les vidables', () => {
    expect(cachesOffer({ root: '/tmp', caches: [cache({ id: 'jest', sizeKB: 5.3 * GB })] })).toEqual({ ids: ['jest'], sizeKB: 5.3 * GB, label: 'Vider le cache Jest (5,3 Go)' });
    const two = cachesOffer({
      root: '/tmp',
      caches: [cache({ id: 'jest', sizeKB: 5 * GB }), cache({ id: 'node-compile-cache', sizeKB: 138 * 1024 }), cache({ id: 'v8-compile-cache', sizeKB: GB, refusal: 'lien symbolique (jamais suivi)' }), cache({ id: 'playwright-transform-cache', sizeKB: 0 })],
    });
    expect(two).toEqual({ ids: ['jest', 'node-compile-cache'], sizeKB: 5 * GB + 138 * 1024, label: 'Vider les caches (5,1 Go)' });
  });
  test('mesure coupée : « au moins »', () => {
    expect(cachesOffer({ root: '/tmp', caches: [cache({ id: 'jest', sizeKB: 2 * GB, atLeast: true })] })?.label).toBe('Vider le cache Jest (au moins 2,0 Go)');
  });
});

describe('cachesOutcomeMessage (toast, notification du résultat)', () => {
  const ok = (id: TmpCache['id'], freedKB: number) => ({ id, name: tmpCacheName(id, 1000), ok: true, freedKB });
  test('tout vidé', () => {
    expect(cachesOutcomeMessage({ results: [ok('jest', 950 * 1024)], freedKB: 950 * 1024 })).toEqual({ message: 'Cache Jest vidé : 950 Mo libérés', kind: 'info' });
    expect(cachesOutcomeMessage({ results: [ok('jest', GB), ok('node-compile-cache', 100 * 1024)], freedKB: GB + 100 * 1024 })).toEqual({ message: '2 caches vidés : 1,1 Go libérés', kind: 'info' });
  });
  test('en partie, refusé, rien à vider', () => {
    const partial: TmpCachesOutcome = { results: [{ id: 'jest', name: 'jest_rs', ok: false, partial: true, freedKB: 900 * 1024, reason: 'temps écoulé' }, ok('node-compile-cache', 10 * 1024)], freedKB: 910 * 1024 };
    expect(cachesOutcomeMessage(partial)).toEqual({ message: 'Caches vidés en partie : 910 Mo libérés ; jest_rs (temps écoulé)', kind: 'error' });
    expect(cachesOutcomeMessage({ results: [{ id: 'jest', name: 'jest_rs', ok: false, freedKB: 0, reason: 'autre utilisateur' }], freedKB: 0 })).toEqual({ message: 'Rien n’a été vidé : jest_rs (autre utilisateur)', kind: 'error' });
    expect(cachesOutcomeMessage({ results: [], freedKB: 0 })).toEqual({ message: 'Aucun cache connu à vider', kind: 'info' });
  });
});

describe('tmpCachesEvent (journal, comme une suppression dans /tmp)', () => {
  test('vidés et refusés, « partial » si un cache l’a été en partie ; rien de fait : pas d’événement', () => {
    expect(tmpCachesEvent({ results: [{ id: 'jest', name: 'jest_rs', ok: false, freedKB: 0, reason: 'autre utilisateur' }], freedKB: 0 }, 5)).toBeNull();
    expect(tmpCachesEvent({ results: [{ id: 'jest', name: 'jest_rs', ok: true, freedKB: 10 }, { id: 'v8-compile-cache', name: 'v8-compile-cache-1000', ok: false, partial: true, freedKB: 2, reason: 'temps écoulé' }], freedKB: 12 }, 5)).toEqual({
      ts: 5, type: 'tmp_clean', groupKey: null,
      detail: { freedKB: 12, deleted: ['jest_rs'], refused: [{ name: 'v8-compile-cache-1000', reason: 'temps écoulé' }], partial: true },
    });
  });
});
