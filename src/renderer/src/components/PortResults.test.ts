import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OpenPort, OpenPortsInfo } from '../../../core/openPorts';
import { OpenPortsPanel } from './OpenPortsPanel';
import { PortResults, portRowEqual } from './PortResults';

const row = (over: Partial<OpenPort> = {}): OpenPort => ({
  port: 3000, pid: 20, startTicks: 200, groupId: 'acme', groupLabel: 'acme', instanceKey: 'acme#20:200', category: 'back', project: 'acme',
  label: 'nest start', ageSec: 60, protected: false, freeable: true, ...over,
});
const noop = () => {};
const count = (html: string, testid: string) => html.split(`data-testid="${testid}"`).length - 1;

describe('rendu des lignes de ports', () => {
  const rows = [
    row(),
    row({ port: 3000, pid: 21, startTicks: 210, instanceKey: 'acme#21:210', protected: true, freeable: false }), // instance protégée
    row({ port: 3000, pid: 30, groupId: 'claude', groupLabel: 'Claude', instanceKey: null, category: null, label: 'node', protected: true, freeable: false }),
    row({ port: 3000, pid: 40, groupId: 'spotify', groupLabel: 'Spotify', instanceKey: null, category: null, label: 'spotify', freeable: false }),
  ];
  const info: OpenPortsInfo = { ports: rows, otherUsers: [{ port: 631, uid: 0 }], unreadable: [7777] };

  it('« Libérer » seulement sur la ligne arrêtable ; les autres : « Voir le groupe », « protégé » si protégées', () => {
    const html = renderToStaticMarkup(createElement(PortResults, { port: 3000, info, pendingPids: new Set<number>(), onFree: noop, onOpenGroup: noop }));
    expect(count(html, 'port-row')).toBe(4);
    expect(count(html, 'free-port')).toBe(1);
    expect(count(html, 'port-open-group')).toBe(3);
    expect(count(html, 'port-protected')).toBe(2);
  });

  it('panneau « Ports ouverts » : mêmes règles, notes comptées sans liste', () => {
    const html = renderToStaticMarkup(createElement(OpenPortsPanel, { info, pendingPids: new Set<number>(), onFree: noop, onOpenGroup: noop }));
    expect(count(html, 'free-port')).toBe(1);
    expect(html).toContain("1 port d&#x27;un autre utilisateur non affiché");
    expect(html).toContain('1 port sans processus lisible');
    expect(html).not.toContain('uid 0');
  });

  it('égalité des lignes (mémoïsation) : même affichage → pas de re-rendu', () => {
    const a = { row: row(), pending: false, onFree: noop, onOpenGroup: noop };
    expect(portRowEqual(a, { ...a, row: row() })).toBe(true);
    expect(portRowEqual(a, { ...a, row: row({ ageSec: 61 }) })).toBe(true); // même « 1 min »
    expect(portRowEqual(a, { ...a, row: row({ ageSec: 7200 }) })).toBe(false);
    expect(portRowEqual(a, { ...a, row: row({ freeable: false }) })).toBe(false);
    expect(portRowEqual(a, { ...a, pending: true })).toBe(false);
  });
});
