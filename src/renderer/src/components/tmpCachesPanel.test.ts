import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TmpCache, TmpCaches } from '../../../core/tmpCaches';
import { AlertPopups } from './AlertPopups';
import { TmpCachesOfferButton, TmpCachesPanel, type TmpCachesState } from './TmpCachesPanel';
import { TmpPage } from './TmpPage';

const GB = 1024 * 1024;
const noop = () => {};
const count = (html: string, testid: string) => html.split(`data-testid="${testid}"`).length - 1;
const c = (o: Partial<TmpCache> & Pick<TmpCache, 'id' | 'name'>): TmpCache => ({ sizeKB: 0, atLeast: false, refusal: null, ...o });
const state = (caches: TmpCaches | null, over: Partial<TmpCachesState> = {}) => ({ caches, error: null, busy: null, empty: async () => {}, ...over });
const render = (s: ReturnType<typeof state>, disabled = false) => renderToStaticMarkup(createElement(TmpCachesPanel, { state: s, disabled }));
const two: TmpCaches = {
  root: '/tmp',
  caches: [c({ id: 'jest', name: 'jest_rs', sizeKB: 5.3 * GB }), c({ id: 'node-compile-cache', name: 'node-compile-cache', sizeKB: 138 * 1024 }), c({ id: 'v8-compile-cache', name: 'v8-compile-cache-1000', refusal: 'lien symbolique (jamais suivi)' })],
};

describe('section « Caches connus » de la page /tmp', () => {
  it('présente sur la page, entre les tuiles et la liste', () => {
    const html = renderToStaticMarkup(createElement(TmpPage, { onToast: noop }));
    expect(count(html, 'tmp-caches')).toBe(1);
    expect(html.indexOf('data-testid="tmp-tiles"')).toBeLessThan(html.indexOf('data-testid="tmp-caches"'));
    expect(html.indexOf('data-testid="tmp-caches"')).toBeLessThan(html.indexOf('data-testid="tmp-clean"'));
  });

  it('chaque cache : libellé, nom, taille, « Vider » s’il est vidable, sinon la raison ; « Tout vider » ; conseil Jest', () => {
    const html = render(state(two));
    expect(count(html, 'tmp-cache-row')).toBe(3);
    expect(html).toContain('Cache de transformation de Jest');
    expect(html).toContain('5,3 Go');
    expect(html).toContain('138 Mo');
    expect(count(html, 'tmp-cache-empty-jest')).toBe(1);
    expect(count(html, 'tmp-cache-empty-node-compile-cache')).toBe(1);
    expect(count(html, 'tmp-cache-empty-v8-compile-cache')).toBe(0);
    expect(html).toContain('lien symbolique (jamais suivi)');
    expect(html).toMatch(/data-testid="tmp-caches-empty-all"[^>]*>.*Tout vider \(5,4 Go\)/);
    expect(count(html, 'tmp-caches-advice')).toBe(1);
    expect(html).toContain('cacheDirectory');
  });

  it('en cours : « Calcul… » ; aucun cache : le dit ; erreur : la montre ; pas de conseil sans cache Jest', () => {
    expect(render(state(null))).toContain('Calcul…');
    const none = render(state({ root: '/tmp', caches: [] }));
    expect(count(none, 'tmp-caches-none')).toBe(1);
    expect(count(none, 'tmp-caches-advice')).toBe(0);
    expect(render(state(null, { error: 'accès refusé (EACCES)' }))).toContain('Lecture impossible : accès refusé (EACCES)');
  });

  it('vidage en cours (ou suppression de la liste) : tous les boutons désactivés, « Vidage… » sur celui qui tourne', () => {
    const html = render(state(two, { busy: ['jest'] }));
    expect(html).toMatch(/data-testid="tmp-cache-empty-jest"[^>]*disabled=""[^>]*>.*Vidage…/);
    expect(html).toMatch(/data-testid="tmp-cache-empty-node-compile-cache"[^>]*disabled=""/);
    expect(render(state(two), true)).toMatch(/data-testid="tmp-caches-empty-all"[^>]*disabled=""/);
  });
});

describe('pop-up d’alerte tmpfs : « Vider les caches (X) »', () => {
  const offer = (s: ReturnType<typeof state>) => renderToStaticMarkup(createElement(TmpCachesOfferButton, { state: s }));
  it('seulement si les caches vidables font au moins 100 Mo ; libellé avec la taille', () => {
    expect(offer(state(null))).toBe('');
    expect(offer(state({ root: '/tmp', caches: [c({ id: 'jest', name: 'jest_rs', sizeKB: 50 * 1024 })] }))).toBe('');
    const html = offer(state(two));
    expect(count(html, 'alert-popup-empty-caches')).toBe(1);
    expect(html).toContain('Vider les caches (5,4 Go)');
    expect(offer(state(two, { busy: ['jest', 'node-compile-cache'] }))).toMatch(/disabled=""[^>]*>.*Vidage…/);
  });
  it('le pop-up tmpfs garde « Voir /tmp » ; les autres alertes n’ont pas ce bouton (rendu sans lecture : aucun bouton tant que les tailles ne sont pas connues)', () => {
    const ev = (type: 'tmpfs' | 'leak') => ({ id: type === 'tmpfs' ? 1 : 2, ts: 1, type, groupKey: null, groupLabel: null, detail: { shmemKB: 6 * GB, thresholdKB: 4 * GB, growthKB: 1, minutes: 1, memKB: 1 } });
    const html = renderToStaticMarkup(createElement(AlertPopups, { pending: [ev('tmpfs'), ev('leak')], onClose: noop, onCloseAll: noop, groupPresent: () => false, onNavigate: noop, onFree: noop, onSnooze: noop, onToast: noop }));
    expect(html).toContain('Voir /tmp');
    expect(count(html, 'alert-popup-empty-caches')).toBe(0);
  });
});
