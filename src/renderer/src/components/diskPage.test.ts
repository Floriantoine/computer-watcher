import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NAV_TABS, TopNav } from './TopNav';
import { SunburstChart } from './SunburstChart';
import type { SunNode } from '../../../core/disk/sunTree';

const noop = () => {};

describe('onglet Disque', () => {
  it('quatrième onglet, juste après /tmp, mène à la page Disque', () => {
    const disk = NAV_TABS[3];
    expect(disk.id).toBe('disk');
    expect(disk.label).toBe('Disque');
    expect(disk.to).toEqual({ view: 'disk' });
  });
  it('actif sur la page Disque seulement', () => {
    expect(renderToStaticMarkup(createElement(TopNav, { route: { view: 'disk' }, onNavigate: noop }))).toMatch(/aria-selected="true"[^>]*data-testid="tab-disk"/);
    expect(renderToStaticMarkup(createElement(TopNav, { route: { view: 'tmp' }, onNavigate: noop }))).toMatch(/aria-selected="false"[^>]*data-testid="tab-disk"/);
  });
});

describe('soleil', () => {
  const tree: SunNode = {
    name: 'u', path: '/h', sizeKB: 1000, children: [
      { name: '.cache', path: '/h/.cache', sizeKB: 600, children: [{ name: 'uv', path: '/h/.cache/uv', sizeKB: 600, children: [] }] },
      { name: 'Documents', path: '/h/Documents', sizeKB: 400, children: [] },
    ],
  };
  const render = (selected: boolean) =>
    renderToStaticMarkup(createElement(SunburstChart, {
      tree, current: '/h', onEnter: noop, onUp: noop, onToggleFamily: noop, onOpen: noop,
      familyOf: (p: string) => (p.startsWith('/h/.cache/uv') ? 'uv' : null),
      isHighlighted: (p: string) => selected && p.startsWith('/h/.cache/uv'),
    }));
  it('un segment par dossier, famille entourée de blanc, surlignée quand cochée ; centre « ~ » et taille', () => {
    const html = render(false);
    expect(html.match(/data-testid="disk-sun-arc"/g)).toHaveLength(3);
    expect(html).toMatch(/data-path="\/h\/.cache\/uv" data-family="uv" class="sun-arc family"[^>]*stroke="#ffffff"/);
    expect(render(true)).toMatch(/class="sun-arc family lit"/);
    expect(html).toContain('>~</text>');
    expect(html).toContain('1000 Ko');
  });
});
