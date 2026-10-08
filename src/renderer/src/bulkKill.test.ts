import { describe, expect, test } from 'vitest';
import type { Category, InstanceSummary, KillResult } from '../../core/types';
import {
  MAX_KILL_TARGETS,
  bulkDialogTitle,
  checkedLive,
  defaultSelection,
  fetchInactive,
  fetchTargets,
  includeLaunchers,
  killBatches,
  presetSelection,
  presetState,
  splitEntries,
  summarizeResults,
  toggleKey,
} from './bulkKill';

let n = 0;
const inst = (category: Category, extra: Partial<InstanceSummary> = {}): InstanceSummary => {
  n++;
  return {
    key: `k${n}`, groupId: 'g', project: '/home/u/acme', category, source: 'command', signature: 'x', label: 'x', rootPid: 100 + n, rootStartTicks: n,
    pids: [100 + n], ports: [], ageSec: 100, rssKB: 1000, swapKB: 0, cpuPercent: 0, duplicate: false, protected: false, ...extra,
  };
};
const keys = (s: Iterable<string>) => [...s].sort();

describe('sélection', () => {
  test('cochées par défaut sauf les protégées', () => {
    const a = inst('front');
    const p = inst('back', { protected: true });
    const b = inst('back');
    expect(keys(defaultSelection([a, p, b]))).toEqual(keys([a.key, b.key]));
  });
  test('une instance dont tous les processus ont déjà reçu SIGTERM n\'est pas cochée', () => {
    const a = inst('front', { pids: [1, 2] });
    const b = inst('back', { pids: [3, 4] });
    expect([...defaultSelection([a, b], new Set([1, 2, 3]))]).toEqual([b.key]);
  });
  test('toggleKey ajoute ou retire sans modifier l\'entrée', () => {
    const s = new Set(['a']);
    expect([...toggleKey(s, 'b')].sort()).toEqual(['a', 'b']);
    expect([...toggleKey(s, 'a')]).toEqual([]);
    expect([...s]).toEqual(['a']);
  });
  test('checkedLive : ordre de la liste, instances disparues ignorées', () => {
    const a = inst('front');
    const b = inst('back');
    const c = inst('worker');
    const sel = new Set([c.key, a.key, b.key]);
    expect(checkedLive([a, b, c], sel, new Set([a.key, c.key]))).toEqual([a.key, c.key]);
  });
});

describe('raccourcis', () => {
  const a = inst('front', { duplicate: true });
  const b = inst('front');
  const p = inst('back', { protected: true, duplicate: true });
  const list = [a, b, p];
  test('« Toutes » = toutes sauf protégées', () => {
    expect(keys(presetSelection(list, 'all', {})!)).toEqual(keys([a.key, b.key]));
  });
  test('« Doublons seulement », protégées jamais cochées par un raccourci', () => {
    expect([...presetSelection(list, 'duplicates', {})!]).toEqual([a.key]);
  });
  test('« Inactives » : résultat de classify:inactive, sans les protégées', () => {
    const inactive = { h1: new Set([b.key, p.key]), d1: new Set<string>() };
    expect([...presetSelection(list, 'inactive1h', inactive)!]).toEqual([b.key]);
    expect([...presetSelection(list, 'inactive1d', inactive)!]).toEqual([]);
  });
  test('« Inactives » indisponibles sans historique (null) ou pendant le chargement', () => {
    expect(presetSelection(list, 'inactive1h', { h1: null })).toBeNull();
    expect(presetSelection(list, 'inactive1d', {})).toBeNull();
    expect(presetState('inactive1h', { h1: null })).toEqual({ enabled: false, reason: expect.stringContaining('historique') });
    expect(presetState('inactive1d', {}).enabled).toBe(false);
    expect(presetState('inactive1d', { d1: new Set() }).enabled).toBe(true);
    expect(presetState('all', { h1: null }).enabled).toBe(true);
    expect(presetState('duplicates', {}).enabled).toBe(true);
  });
});

describe('lanceurs (« Tout arrêter »)', () => {
  const a = inst('front');
  const b = inst('back');
  const live = new Set([a.key, b.key]);
  test('seulement avec « Tout arrêter » et toutes les instances encore présentes cochées', () => {
    expect(includeLaunchers('g', [a, b], new Set([a.key, b.key]), live)).toBe(true);
    expect(includeLaunchers(undefined, [a, b], new Set([a.key, b.key]), live)).toBe(false);
    expect(includeLaunchers('g', [a, b], new Set([a.key]), live)).toBe(false);
  });
  test('une instance disparue ne bloque pas les lanceurs ; aucune cochée → pas de lanceurs', () => {
    expect(includeLaunchers('g', [a, b], new Set([a.key]), new Set([a.key]))).toBe(true);
    expect(includeLaunchers('g', [a, b], new Set(), new Set())).toBe(false);
  });
});

describe('requêtes découpées', () => {
  test('fetchTargets : lots de 200 clés au plus, réponses concaténées', async () => {
    const calls: number[] = [];
    const ks = Array.from({ length: 450 }, (_, i) => `k${i}`);
    const out = await fetchTargets(ks, async (b) => {
      calls.push(b.length);
      return b.map((key) => ({ key, targets: [] }));
    });
    expect(calls).toEqual([200, 200, 50]);
    expect(out.map((e) => e.key)).toEqual(ks);
  });
  test('fetchTargets sans clé : aucun appel', async () => {
    expect(await fetchTargets([], async () => { throw new Error('appel inattendu'); })).toEqual([]);
  });
  test('fetchInactive : union des lots ; null si un lot n\'a pas d\'historique', async () => {
    const ks = Array.from({ length: 250 }, (_, i) => `k${i}`);
    const r = await fetchInactive(ks, 1000, async (b, since) => (expect(since).toBe(1000), b.filter((k) => k.endsWith('7'))));
    expect(r!.size).toBe(25);
    expect(await fetchInactive(ks, 1000, async (b) => (b[0] === 'k200' ? null : []))).toBeNull();
    expect(await fetchInactive([], 1000, async () => null)).toEqual(new Set());
  });
});

describe('cibles et lots', () => {
  const t = (pid: number) => ({ pid, startTicks: pid * 10 });
  test('splitEntries : instances (clés cochées), lanceurs (clé du groupe), disparues', () => {
    const r = splitEntries(['a', 'b', 'c'], 'g', [
      { key: 'a', targets: [t(1), t(2)] },
      { key: 'b', targets: [] },
      { key: 'g', targets: [t(9)] },
    ]);
    expect(r.instances).toEqual([{ key: 'a', targets: [t(1), t(2)] }]);
    expect(r.launchers).toEqual([t(9)]);
    expect(r.gone).toEqual(['b', 'c']);
  });
  test('killBatches : ≤ 2 000 cibles par appel, une instance reste dans un même lot si elle tient', () => {
    const big = (from: number, count: number) => Array.from({ length: count }, (_, i) => t(from + i));
    const batches = killBatches([{ key: 'a', targets: big(1, 1500) }, { key: 'b', targets: big(5000, 800) }], big(9000, 3));
    expect(batches.map((b) => b.length)).toEqual([1500, 803]);
    expect(batches.every((b) => b.length <= MAX_KILL_TARGETS)).toBe(true);
    const huge = killBatches([{ key: 'a', targets: big(1, 4100) }], []);
    expect(huge.map((b) => b.length)).toEqual([2000, 2000, 100]);
    expect(killBatches([], [])).toEqual([]);
  });
  test('killBatches : un pid présent dans deux entrées n\'est envoyé qu\'une fois', () => {
    expect(killBatches([{ key: 'a', targets: [t(1)] }, { key: 'b', targets: [t(1), t(2)] }], [t(2)])).toEqual([[t(1), t(2)]]);
  });
});

describe('summarizeResults', () => {
  const ok = (pid: number): KillResult => ({ pid, ok: true });
  const err = (pid: number, error: string): KillResult => ({ pid, ok: false, error });
  test('un seul message : arrêtées, refusées avec la raison', () => {
    const per = [1, 2, 3, 4, 5].map((i) => ({ key: `k${i}`, pids: [i] }));
    per.push({ key: 'k6', pids: [123] });
    const results = [ok(1), ok(2), ok(3), ok(4), ok(5), err(123, 'EPERM')];
    expect(summarizeResults(per, results, 0)).toEqual({ message: '5 instances arrêtées, 1 refusée : PID 123 permission refusée', kind: 'error' });
  });
  test('disparues : clés absentes et instances dont tous les pids sont ESRCH', () => {
    const r = summarizeResults([{ key: 'a', pids: [1] }, { key: 'b', pids: [2, 3] }], [ok(1), err(2, 'ESRCH'), err(3, 'ESRCH')], 2);
    expect(r).toEqual({ message: '1 instance arrêtée, 3 déjà disparues', kind: 'info' });
  });
  test('rien d\'arrêté', () => {
    expect(summarizeResults([], [], 1).message).toBe('Aucune instance arrêtée, 1 déjà disparue');
    expect(summarizeResults([{ key: 'a', pids: [7] }], [err(7, 'SELF')], 0)).toEqual({
      message: "Aucune instance arrêtée, 1 refusée : PID 7 c'est proc-watch ou l'un de ses parents",
      kind: 'error',
    });
  });
  test('instance en partie arrêtée = refusée ; au plus 3 raisons ; erreurs des lanceurs signalées', () => {
    const per = [{ key: 'a', pids: [1, 2] }, { key: 'b', pids: [3] }, { key: 'c', pids: [4] }, { key: 'd', pids: [5] }];
    const results = [ok(1), err(2, 'EPERM'), err(3, 'EPERM'), err(4, 'EINVAL'), err(5, 'EPERM'), err(9, 'EPERM')];
    expect(summarizeResults(per, results, 0).message).toBe(
      'Aucune instance arrêtée, 4 refusées : PID 2 permission refusée, PID 3 permission refusée, PID 4 EINVAL, +2',
    );
  });
  test('lanceurs arrêtés : pas comptés comme instances', () => {
    expect(summarizeResults([{ key: 'a', pids: [1] }], [ok(1), ok(50)], 0)).toEqual({ message: '1 instance arrêtée', kind: 'info' });
  });
});

describe('bulkDialogTitle', () => {
  test('selon le contexte', () => {
    const a = inst('front', { project: '/home/u/acme' });
    const b = inst('back', { project: '/home/u/acme' });
    const c = inst('back', { project: '/home/u/other' });
    expect(bulkDialogTitle([a, b], 'g', 'acme')).toBe('Tout arrêter dans « acme » ?');
    expect(bulkDialogTitle([a, b], undefined, 'acme')).toBe('Arrêter 2 instances de « acme » ?');
    expect(bulkDialogTitle([a], undefined, 'acme')).toBe('Arrêter 1 instance de « acme » ?');
    expect(bulkDialogTitle([a, c], undefined, null)).toBe('Arrêter 2 instances de 2 projets ?');
  });
});
