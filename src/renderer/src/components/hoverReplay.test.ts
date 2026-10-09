import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { GroupSummary, InstanceSummary, ProcTreeAt, ProcTreeRow } from '../../../core/types';
import type { Replay } from '../useReplay';
import { DetailTiles } from './DetailTiles';
import { InstancesPanel } from './InstancesPanel';
import { ReplayPanel } from './ReplayPanel';

const inst = (extra: Partial<InstanceSummary> = {}): InstanceSummary => ({
  key: 'project:/acme#10:100', groupId: 'project:/acme', project: '/home/u/acme', category: 'back', source: 'name', signature: 'x', label: 'nest start',
  rootPid: 10, rootStartTicks: 100, pids: [10], ports: [], ageSec: 100, rssKB: 1000, swapKB: 0, cpuPercent: 0, duplicate: false, protected: false, ...extra,
});
const group: GroupSummary = {
  id: 'project:/acme', kind: 'project', label: 'acme', tags: [], rootName: 'node', pids: [10, 11], procCount: 2, cpuPercent: 12, rssKB: 2048, swapKB: 0,
  oldestAgeSec: 3600, protected: false, killable: true, subgroups: [], categories: ['back'], instances: [inst()],
};
const AT = new Date(2026, 9, 9, 10, 54, 35).getTime();
const count = (html: string, testid: string) => html.split(`data-testid="${testid}"`).length - 1;
const noop = () => {};

describe('tuiles du détail', () => {
  test('en direct : valeurs du groupe, pas de badge', () => {
    const html = renderToStaticMarkup(createElement(DetailTiles, { group, memMetric: 'rss', at: null, now: AT }));
    expect(count(html, 'tile-at')).toBe(0);
    expect(html).toContain('>2<'); // Processus
    expect(html).toContain('12 %'); // CPU
  });

  test('aperçu ou instant figé : valeurs de l\'instant, badge « au HH:MM:SS », « Plus ancien » en —', () => {
    const at = { ts: AT, values: { procCount: 7, rssKB: 3 * 1024 * 1024, swapKB: 512, cpu: 41.6 } };
    const html = renderToStaticMarkup(createElement(DetailTiles, { group, memMetric: 'rss', at, now: AT }));
    expect(count(html, 'tile-at')).toBe(4);
    expect(html).toContain('au 10:54:35');
    expect(html).toContain('>7<');
    expect(html).toContain('3,0 Go');
    expect(html).toContain('512 Ko');
    expect(html).toContain('42 %');
    expect(html).toMatch(/data-testid="tile-oldest"[^>]*>—</);
  });

  test('instant sans valeurs (hors des séries, nombre de processus non enregistré) : —', () => {
    const html = renderToStaticMarkup(createElement(DetailTiles, { group, memMetric: 'pss', at: { ts: AT, values: null }, now: AT }));
    expect(html.match(/>—</g)?.length).toBe(5);
  });
});

describe('arbre rejoué pendant l\'aperçu', () => {
  const row = (pid: number, ppid: number | null): ProcTreeRow => ({ pid, startTicks: pid, ppid, name: `p${pid}`, rssKB: 100, swapKB: 0, cpu: 1, sampleTs: AT, lastSeenTs: AT });
  const tree: ProcTreeAt = { ts: AT, source: 'detail', procs: [row(10, null), row(11, 10), row(12, 10)], recorded: true, omitted: 0 };
  const replay = { instant: AT, pinned: null, playing: false, tree, tiles: null, pick: noop, play: noop, pause: noop, live: noop, hover: noop, setSeries: noop } as Replay;

  test('aucun bouton de kill : seul « Revenir au direct »', () => {
    const html = renderToStaticMarkup(createElement(ReplayPanel, { replay, liveRoots: null }));
    expect(count(html, 'replay-row')).toBe(3);
    expect(html.match(/<button/g)?.length).toBe(1);
    expect(count(html, 'replay-live')).toBe(1);
    expect(html).not.toMatch(/Tuer|kill/i);
    expect(html).toContain('Arbre au');
  });
});

describe('section Instances pendant l\'aperçu', () => {
  const props = {
    group, sparks: new Map(), ticksOf: new Map(), stuckPids: new Set<number>(), pendingPids: new Set<number>(),
    onReclassify: noop, onKillInstance: noop, onForce: noop,
  };
  test('estompée avec « en direct » ; rien en direct', () => {
    const dim = renderToStaticMarkup(createElement(InstancesPanel, { ...props, liveOnly: true }));
    expect(dim).toMatch(/class="instances-panel is-live-only"/);
    expect(count(dim, 'instances-live-note')).toBe(1);
    expect(dim).toContain('en direct');
    const live = renderToStaticMarkup(createElement(InstancesPanel, props));
    expect(count(live, 'instances-live-note')).toBe(0);
  });
});
