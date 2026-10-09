import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AlertEvent } from '../../../core/alerts';
import type { TmpEntry, TmpListing } from '../../../core/tmpClean';
import type { HistoryEvent } from '../../../core/types';
import { tmpTiles } from '../tmpClean';
import { AlertPopups } from './AlertPopups';
import { AlertsPanel } from './AlertsPanel';
import { TmpCleanList, type TmpClean } from './TmpCleanList';
import { TmpDirsList } from './TmpDirsList';
import { TmpPage, TmpTiles } from './TmpPage';
import { NAV_TABS, TopNav } from './TopNav';

const noop = () => {};
const count = (html: string, testid: string) => html.split(`data-testid="${testid}"`).length - 1;
const entry = (name: string, sizeKB: number, refusal: string | null = null): TmpEntry => ({ name, ino: name, dev: '1', kind: 'dir', sizeKB, cache: false, recent: false, refusal });
const listing = (over: Partial<TmpListing> = {}): TmpListing => ({ root: '/tmp', entries: [], truncated: false, uninspectable: [], disabled: null, quarantines: [], ...over });
const clean = (l: TmpListing | null, over: Partial<TmpClean> = {}): TmpClean => ({
  listing: l, error: null, selected: new Set(), busy: false, toggle: noop, run: async () => {}, emptyQuarantine: async () => {}, load: noop, ...over,
});

describe('onglet /tmp', () => {
  it('troisième onglet, juste après Métriques, mène à la page /tmp', () => {
    expect(NAV_TABS.map((t) => t.id)).toEqual(['main', 'metrics', 'tmp', 'disk']);
    const tmp = NAV_TABS[2];
    expect(tmp.label).toBe('/tmp');
    expect(tmp.to).toEqual({ view: 'tmp' });
  });

  it('actif sur la page /tmp (et seulement là)', () => {
    const onTmp = renderToStaticMarkup(createElement(TopNav, { route: { view: 'tmp' }, onNavigate: noop }));
    expect(onTmp).toMatch(/aria-selected="true"[^>]*data-testid="tab-tmp"/);
    expect(count(onTmp, 'tab-tmp')).toBe(1);
    const onMetrics = renderToStaticMarkup(createElement(TopNav, { route: { view: 'metrics' }, onNavigate: noop }));
    expect(onMetrics).toMatch(/aria-selected="false"[^>]*data-testid="tab-tmp"/);
  });
});

describe('page /tmp', () => {
  it('trois tuiles (Occupé, Part de la RAM, Quarantaine), tri par taille par défaut, « Actualiser »', () => {
    const html = renderToStaticMarkup(createElement(TmpPage, { onToast: noop }));
    expect(count(html, 'tmp-page')).toBe(1);
    expect(count(html, 'tmp-tile')).toBe(3);
    for (const label of ['Occupé', 'Part de la RAM', 'Quarantaine']) expect(html).toContain(`<small>${label}</small>`);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="tmp-sort-size"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-testid="tmp-sort-name"/);
    expect(count(html, 'tmp-refresh')).toBe(1);
    expect(count(html, 'tmp-clean')).toBe(1);
  });

  it('tuiles avec valeurs ; bouton « Vider la quarantaine » dans la tuile quand c’est vidable', () => {
    const GB = 1024 * 1024;
    const tiles = tmpTiles({
      stats: { root: '/tmp', sizeKB: 8 * GB, usedKB: 2 * GB, memTotalKB: 16 * GB, inRam: true }, statsError: null,
      listing: listing({ quarantines: [{ name: '.proc-watch-trash-1', eligible: true }] }), listingError: null,
    });
    const html = renderToStaticMarkup(createElement(TmpTiles, { tiles, busy: false, onEmptyQuarantine: noop }));
    expect(html).toContain('2,0 Go / 8,0 Go');
    expect(html).toContain('12,5 %');
    expect(count(html, 'tmp-clean-empty-quarantine')).toBe(1);
    expect(html).not.toContain('tile-error');
    expect(html).toContain('quarantaine restée (suppression interrompue)');
  });

  it('quarantaine non vidable : signalée à part, sans bouton', () => {
    const tiles = tmpTiles({ stats: null, statsError: null, listing: listing({ quarantines: [{ name: '.proc-watch-trash-x', eligible: false }] }), listingError: null });
    const html = renderToStaticMarkup(createElement(TmpTiles, { tiles, busy: false, onEmptyQuarantine: noop }));
    expect(html).toContain('+ 1 non vidable');
    expect(count(html, 'tmp-tile-extra')).toBe(1);
    expect(html).toContain('Dossiers .computer-watcher-trash-* ou .proc-watch-trash-* que Computer Watcher ne peut pas vider');
    expect(html).not.toMatch(/que proc-watch/);
    expect(count(html, 'tmp-clean-empty-quarantine')).toBe(0);
  });

  it('/tmp illisible : les tuiles affichent l’erreur, pas de NaN ni de bouton', () => {
    const tiles = tmpTiles({ stats: null, statsError: 'accès refusé (EACCES)', listing: null, listingError: 'accès refusé (EACCES)' });
    const html = renderToStaticMarkup(createElement(TmpTiles, { tiles, busy: false, onEmptyQuarantine: noop }));
    expect(count(html, 'tmp-tile-error')).toBe(3);
    expect(html).toContain('Lecture impossible : accès refusé (EACCES)');
    expect(html).not.toContain('NaN');
    expect(count(html, 'tmp-clean-empty-quarantine')).toBe(0);
  });
});

describe('liste de la page /tmp (TmpCleanList)', () => {
  const l = listing({ entries: [entry('feature-x', 10), entry('acme', 900), entry('zeta', 50, 'système')] });
  const names = (html: string) => [...html.matchAll(/<label[^>]*>([^<]*)<\/label>/g)].map((m) => m[1]);

  it('triée par taille décroissante ou par nom', () => {
    expect(names(renderToStaticMarkup(createElement(TmpCleanList, { clean: clean(l), sort: 'size' })))).toEqual(['acme', 'zeta', 'feature-x']);
    expect(names(renderToStaticMarkup(createElement(TmpCleanList, { clean: clean(l), sort: 'name' })))).toEqual(['acme', 'feature-x', 'zeta']);
  });

  it('comportement conservé : raison de refus, résumé de la sélection, « Supprimer la sélection (n · taille) »', () => {
    const html = renderToStaticMarkup(createElement(TmpCleanList, { clean: clean(l, { selected: new Set(['acme']) }), sort: 'size' }));
    expect(count(html, 'tmp-clean-row')).toBe(3);
    expect(html).toContain('système');
    expect(count(html, 'tmp-clean-summary')).toBe(1);
    expect(html).toContain('Supprimer la sélection (1 · 900 Ko)');
  });

  it('quarantaine restée : signalée dans la liste (le bouton pour la vider est dans la tuile)', () => {
    const html = renderToStaticMarkup(createElement(TmpCleanList, { clean: clean(listing({ quarantines: [{ name: '.proc-watch-trash-1', eligible: true }] })), sort: 'size' }));
    expect(count(html, 'tmp-clean-quarantine')).toBe(1);
    expect(count(html, 'tmp-clean-empty-quarantine')).toBe(0);
    expect(html).toContain('Une quarantaine de Computer Watcher');
  });

  it('erreur de lecture et calcul en cours', () => {
    expect(renderToStaticMarkup(createElement(TmpCleanList, { clean: clean(null, { error: 'accès refusé (EACCES)' }), sort: 'size' }))).toContain('Lecture de /tmp impossible : accès refusé (EACCES)');
    expect(renderToStaticMarkup(createElement(TmpCleanList, { clean: clean(null), sort: 'size' }))).toContain('Calcul…');
  });
});

describe('« Voir /tmp » mène à la page, plus de liste dépliée', () => {
  it('panneau Alertes (Métriques) : bouton sans état déplié, sans liste', () => {
    const ev: HistoryEvent = { ts: 1_700_000_000_000, type: 'tmpfs', groupKey: null, groupLabel: null, detail: { shmemKB: 4 * 1024 * 1024, thresholdKB: 2 * 1024 * 1024 } };
    const html = renderToStaticMarkup(createElement(AlertsPanel, { events: [ev], onPick: noop, onOpenTmp: noop }));
    expect(count(html, 'tmpfs-toggle')).toBe(1);
    expect(html).toContain('Voir /tmp');
    expect(html).not.toContain('aria-expanded');
    expect(count(html, 'tmp-clean')).toBe(0);
  });

  it('pop-up d’alerte tmpfs : « Voir /tmp » sans état déplié, sans liste', () => {
    const e: AlertEvent = { id: 1, ts: 1_700_000_000_000, type: 'tmpfs', groupKey: null, groupLabel: null, detail: { shmemKB: 1, thresholdKB: 1 } };
    const html = renderToStaticMarkup(
      createElement(AlertPopups, { pending: [e], onClose: noop, onCloseAll: noop, groupPresent: () => false, onNavigate: noop, onFree: noop, onSnooze: noop }),
    );
    expect(html).toContain('Voir /tmp');
    expect(html).not.toContain('aria-expanded');
    expect(count(html, 'tmp-dirs')).toBe(0);
  });

  it('explorateur du swap : la note renvoie à la page /tmp par un bouton', () => {
    const html = renderToStaticMarkup(createElement(TmpDirsList, { onOpenTmp: noop }));
    expect(count(html, 'tmp-dirs-open-page')).toBe(1);
    expect(html).not.toContain('Métriques › Alertes › Voir /tmp');
  });
});
