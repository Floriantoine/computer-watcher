import { describe, expect, test } from 'vitest';
import type { SwapRow, SwapView } from '../../core/swap';
import type { GroupSummary, InstanceSummary } from '../../core/types';
import { parseSwapSleepMB, rowAction, sleepLabel, sleepingInstances, stopOneCheck, stopSleepingLabel } from './swapPanel';

const H = 3600_000;
const D = 24 * H;
const NOW = 100 * D;

const row = (over: Partial<SwapRow> = {}): SwapRow => ({
  key: 'app:spotify', groupId: 'app:spotify', label: 'Spotify', kind: 'app', category: null, project: null, swapKB: 400 * 1024, rssKB: 0,
  instanceKey: null, state: { kind: 'sleeping', sinceTs: NOW - 3 * D }, bulkEligible: false, protected: false, killable: true, children: [], ...over,
});

const inst = (key: string, groupId: string, over: Partial<InstanceSummary> = {}): InstanceSummary => ({
  key, groupId, project: 'acme', category: 'back', source: 'command', signature: 'nest', label: 'nest', rootPid: 1, rootStartTicks: 1, pids: [1], ports: [],
  ageSec: 0, rssKB: 0, swapKB: 0, cpuPercent: 0, duplicate: false, protected: false, ...over,
});

const grp = (id: string, kind: GroupSummary['kind'], instances: InstanceSummary[] = [], over: Partial<GroupSummary> = {}): GroupSummary => ({
  id, kind, label: id, tags: [], rootName: id, pids: [], procCount: 1, cpuPercent: 0, rssKB: 0, swapKB: 0, oldestAgeSec: 0, protected: false, killable: true,
  subgroups: [], categories: [], instances, ...over,
});

const view = (sleepingKeys: string[]): SwapView => ({ swapUsedKB: 0, swapTotalKB: 0, shmemKB: null, historyFrom: NOW - 10 * D, rows: [], sleepingKeys });

describe('sleepLabel', () => {
  test('actif, endormi depuis 3 j, depuis plus de (historique), inconnu', () => {
    expect(sleepLabel({ kind: 'active' }, NOW, null)).toBe('actif');
    expect(sleepLabel({ kind: 'sleeping', sinceTs: NOW - 3 * D }, NOW, NOW - 10 * D)).toBe('endormi depuis 3 j');
    expect(sleepLabel({ kind: 'sleeping', sinceTs: NOW - 30 * H }, NOW, NOW - 10 * D)).toBe('endormi depuis 1 j');
    expect(sleepLabel({ kind: 'sleeping', sinceTs: null }, NOW, NOW - 30 * D)).toBe('endormi depuis plus de 30 j');
    expect(sleepLabel({ kind: 'sleeping', sinceTs: null }, NOW, null)).toBe('endormi');
    expect(sleepLabel({ kind: 'unknown' }, NOW, null)).toBe('inconnu (historique insuffisant)');
  });
});

test('stopSleepingLabel', () => {
  expect(stopSleepingLabel(0)).toBe('Arrêter les endormis (0)');
  expect(stopSleepingLabel(1)).toBe('Arrêter les endormis (1)');
  expect(stopSleepingLabel(3)).toBe('Arrêter les endormis (3)');
});

describe('sleepingInstances', () => {
  test('instances des clés présentes au snapshot (sous-groupes compris), clé disparue ignorée', () => {
    const a = inst('project:/a#1:1', 'project:/a');
    const b = inst('deleted:/b#2:2', 'deleted:/b');
    const groups = [grp('project:/a', 'project', [a]), grp('others', 'others', [], { subgroups: [grp('deleted:/b', 'deleted', [b])] })];
    expect(sleepingInstances(view([a.key, 'project:/x#9:9', b.key]), groups)).toEqual([a, b]);
    expect(sleepingInstances(null, groups)).toEqual([]);
  });

  test('défense : jamais une instance protégée, lancée par Claude, ni hors projet / dossier supprimé', () => {
    const p = inst('project:/a#1:1', 'project:/a', { protected: true });
    const c = inst('project:/a#2:2', 'project:/a', { launchedBy: 'claude' });
    const app = inst('app:pg#3:3', 'app:pg');
    const groups = [grp('project:/a', 'project', [p, c]), grp('app:pg', 'app', [app])];
    expect(sleepingInstances(view([p.key, c.key, app.key]), groups)).toEqual([]);
  });
});

describe('rowAction', () => {
  test('appli endormie tuable → stop-one ; instance de projet endormie → none (arrêt groupé) ; inconnu / actif → none', () => {
    expect(rowAction(row())).toBe('stop-one');
    expect(rowAction(row({ kind: 'command' }))).toBe('stop-one');
    expect(rowAction(row({ kind: 'project', key: 'project:/a#1:1', killable: false, bulkEligible: true }))).toBe('none');
    expect(rowAction(row({ kind: 'project', key: 'project:/a', killable: false }))).toBe('none');
    expect(rowAction(row({ state: { kind: 'unknown' } }))).toBe('none');
    expect(rowAction(row({ state: { kind: 'active' } }))).toBe('none');
  });

  test('jamais Claude, jamais protégé, jamais non tuable', () => {
    expect(rowAction(row({ kind: 'claude', killable: false }))).toBe('none');
    expect(rowAction(row({ kind: 'claude', killable: true }))).toBe('none');
    expect(rowAction(row({ protected: true }))).toBe('none');
    expect(rowAction(row({ killable: false }))).toBe('none');
  });
});

describe('stopOneCheck (garde du clic « Arrêter »)', () => {
  test('groupe présent, appli non protégée et tuable → ok', () => {
    expect(stopOneCheck(row(), grp('app:spotify', 'app'))).toEqual({ ok: true });
  });
  test('groupe disparu, devenu protégé, Claude ou non tuable → refus avec message', () => {
    expect(stopOneCheck(row(), undefined)).toEqual({ ok: false, message: '« Spotify » a disparu' });
    for (const g of [grp('app:spotify', 'app', [], { protected: true }), grp('app:spotify', 'app', [], { killable: false }), grp('app:spotify', 'claude')])
      expect(stopOneCheck(row(), g).ok).toBe(false);
    expect(stopOneCheck(row({ state: { kind: 'active' } }), grp('app:spotify', 'app')).ok).toBe(false);
  });
});

test('parseSwapSleepMB : entier de 1 à 65 536 (mêmes bornes que la config)', () => {
  expect(parseSwapSleepMB('100')).toBe(100);
  expect(parseSwapSleepMB(' 500 ')).toBe(500);
  expect(parseSwapSleepMB('65536')).toBe(65_536);
  for (const bad of ['', '0', '-5', '1.5', '65537', 'abc', '1e3x']) expect(parseSwapSleepMB(bad)).toBeNull();
});
