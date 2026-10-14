import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NAV_TABS, TopNav } from './TopNav';
import { SunburstChart } from './SunburstChart';
import type { SunNode } from '../../../core/disk/sunTree';
import type { ExtrasView } from '../../../core/disk/extras';
import { DiskExtras } from './DiskExtras';
import { emptyExtraSelection, toggleExtra } from '../disk';

const noop = () => {};

const H = '/home/u';
const EXTRAS: ExtrasView = {
  at: 0, days: 30, home: H,
  projectRoots: { roots: [`${H}/code`], isDefault: true, missing: [] },
  nodeModules: [{ path: `${H}/code/vieux/node_modules`, projectDir: `${H}/code/vieux`, label: 'code / vieux', sizeKB: 2048, lastSeen: null, partialHistory: true }],
  worktrees: [
    { path: `${H}/code/depot/.worktrees/fini`, repo: `${H}/code/depot`, branch: 'fini', head: 'a', label: 'depot › fini', sizeKB: 1024, refusal: null },
    { path: `${H}/code/depot/.worktrees/secret`, repo: `${H}/code/depot`, branch: 'secret', head: 'b', label: 'depot › secret', sizeKB: 10, refusal: 'fichiers ignorés qui seraient perdus : .env' },
  ],
  projectErrors: [], truncated: false, gitMissing: false,
  cacheDirs: { dirs: [{ name: 'outil-inconnu', path: `${H}/.cache/outil-inconnu`, sizeKB: 512, refusal: null }], refusal: null },
  docker: { version: '27.1.1', actions: [{ id: 'images', reclaimKB: 300, items: ['demo/old:0.9 (300MB)'] }, { id: 'containers', reclaimKB: null, items: [] }, { id: 'volumes', reclaimKB: 60, items: [] }] },
};

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

describe('sections du lot 2', () => {
  it('node_modules, worktrees (refus = case désactivée), ~/.cache avec avertissement, Docker', () => {
    const html = renderToStaticMarkup(createElement(DiskExtras, { extras: EXTRAS, error: null, loading: false, sel: toggleExtra(emptyExtraSelection(), 'docker', 'images'), busy: false, onToggle: noop }));
    expect(html).toMatch(/data-testid="disk-nm-row" data-key="\/home\/u\/code\/vieux\/node_modules"[\s\S]*historique partiel/);
    expect(html).toMatch(/data-testid="disk-wt-row" data-key="\/home\/u\/code\/depot\/.worktrees\/secret"[^>]*>[\s\S]*?disabled=""[\s\S]*?fichiers ignorés qui seraient perdus : .env/);
    expect(html).toMatch(/inconnu : vérifie avant/);
    expect(html).toMatch(/data-testid="disk-docker-row" data-key="images"[^>]*>[\s\S]*?checked=""/);
    expect(html).toMatch(/demo\/old:0.9/);
  });
  it('sans Docker ni git : sections absentes, message pour git', () => {
    const html = renderToStaticMarkup(createElement(DiskExtras, { extras: { ...EXTRAS, docker: null, gitMissing: true, worktrees: [] }, error: null, loading: false, sel: emptyExtraSelection(), busy: false, onToggle: noop }));
    expect(html).not.toMatch(/disk-docker-row/);
    expect(html).toMatch(/git introuvable/);
  });
  it('dossiers de projets introuvables signalés ; Docker sans rien à retirer non cochable', () => {
    const html = renderToStaticMarkup(createElement(DiskExtras, { extras: { ...EXTRAS, projectRoots: { roots: [`${H}/code`], isDefault: false, missing: [`${H}/parti`] } }, error: null, loading: false, sel: emptyExtraSelection(), busy: false, onToggle: noop }));
    expect(html).toContain(`· introuvable : ${H}/parti`);
    expect(html).toMatch(/data-testid="disk-docker-row" data-key="containers"[^>]*>[\s\S]*?disabled=""/);
    expect(html).not.toMatch(/data-testid="disk-docker-row" data-key="volumes"[^>]*><input[^>]*disabled=""/);
  });
  it('échec d’actualisation : bandeau d’erreur, ancienne liste visible mais non cochable', () => {
    const html = renderToStaticMarkup(createElement(DiskExtras, { extras: EXTRAS, error: 'analyse impossible', loading: false, sel: emptyExtraSelection(), busy: false, onToggle: noop }));
    expect(html).toMatch(/role="alert"[^>]*>[^<]*analyse impossible/);
    expect(html).toMatch(/disk-nm-row/);
    expect(html.match(/<input type="checkbox"[^>]*>/g)!.every((i) => i.includes('disabled=""'))).toBe(true);
  });
});
