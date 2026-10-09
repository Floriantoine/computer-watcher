import { describe, expect, test, vi } from 'vitest';
import type { ProcInfo, ProcNode, ProcTreeAt, ProcTreeRow } from '../../core/types';
import { ClickDelay, liveKeySet, nextReplayTs, REPLAY_SPEED, replayEmptyText, replayInstant, replayTree, tilesAt, type ReplayNode } from './replay';
import { replayReducer, type ReplayState } from './useReplay';

const row = (pid: number, ppid: number | null, rssKB = 100, swapKB: number | null = 0, lastSeenTs = 1000): ProcTreeRow => ({
  pid, startTicks: pid * 10, ppid, name: `p${pid}`, rssKB, swapKB, cpu: 0, sampleTs: 500, lastSeenTs,
});
const alive = () => true;
const shape = (ns: ReplayNode[]): unknown[] => ns.map((n) => [n.row.pid, ...(n.children.length ? [shape(n.children)] : [])]);

describe('replayTree', () => {
  test('chaîne A → B → C : un seul arbre', () => {
    const t = replayTree([row(3, 2), row(1, 0), row(2, 1)], alive);
    expect(shape(t)).toEqual([[1, [[2, [[3]]]]]]);
  });

  test('parent absent des lignes : racine', () => {
    expect(shape(replayTree([row(5, 999), row(6, null)], alive)).length).toBe(2);
  });

  test('cycle A ↔ B : une seule racine, pas de boucle infinie', () => {
    const t = replayTree([row(1, 2), row(2, 1)], alive);
    expect(t).toHaveLength(1);
    expect(t[0].children).toHaveLength(1);
    expect(t[0].children[0].children).toHaveLength(0);
  });

  test('tri par mémoire (rss + swap) décroissante, swap inconnu = 0', () => {
    const t = replayTree([row(1, null, 100, null), row(2, null, 50, 100), row(3, null, 120, 0)], alive);
    expect(t.map((n) => n.row.pid)).toEqual([2, 3, 1]);
  });

  test('processus mort depuis : dead, diedAt = lastSeenTs ; vivant : diedAt null', () => {
    const t = replayTree([row(1, null, 100, 0, 7000), row(2, 1, 100, 0, 4000)], (pid, st) => !(pid === 2 && st === 20));
    expect(t[0]).toMatchObject({ dead: false, diedAt: null });
    expect(t[0].children[0]).toMatchObject({ dead: true, diedAt: 4000 });
  });
});

test('liveKeySet : clés pid:startTicks de tout l\'arbre en direct', () => {
  const node = (pid: number, children: ProcNode[] = []): ProcNode => ({ proc: { pid, startTicks: pid + 1 } as ProcInfo, children });
  expect(liveKeySet([node(1, [node(2, [node(3)])]), node(4)])).toEqual(new Set(['1:2', '2:3', '3:4', '4:5']));
  expect(liveKeySet(null)).toEqual(new Set());
});

test('nextReplayTs : ×60, borné à la fin de la plage', () => {
  expect(REPLAY_SPEED).toBe(60);
  const t = 1_000_000;
  const range = { from: t - 10_000, to: t + 90_000 };
  const a = nextReplayTs(t, range, 1000);
  expect(a).toEqual({ ts: t + 60_000, done: false });
  expect(nextReplayTs(a.ts, range, 1000)).toEqual({ ts: t + 90_000, done: true });
});

describe('replayReducer (état du rejeu)', () => {
  const t = 1_000_000;
  const range = { from: t - 600_000, to: t + 90_000 };
  const direct: ReplayState = { instant: null, playing: false, range: null };

  test('pick fige l\'instant sans lecture', () => {
    expect(replayReducer(direct, { type: 'pick', ts: t })).toEqual({ instant: t, playing: false, range: null });
  });

  test('play sans instant : départ au début de la plage', () => {
    expect(replayReducer(direct, { type: 'play', range })).toEqual({ instant: range.from, playing: true, range });
  });

  test('play depuis un instant figé : départ à cet instant', () => {
    expect(replayReducer({ instant: t, playing: false, range: null }, { type: 'play', range })).toEqual({ instant: t, playing: true, range });
  });

  test('play depuis la fin de la plage (ou hors plage) : repart du début', () => {
    expect(replayReducer({ instant: range.to, playing: false, range }, { type: 'play', range })).toMatchObject({ instant: range.from, playing: true });
    expect(replayReducer({ instant: range.from - 1, playing: false, range: null }, { type: 'play', range })).toMatchObject({ instant: range.from });
  });

  test('tick : +60 s par seconde ; au-delà de la fin, instant = fin et lecture arrêtée', () => {
    const s1 = replayReducer({ instant: t, playing: true, range }, { type: 'tick', elapsedMs: 1000 });
    expect(s1).toEqual({ instant: t + 60_000, playing: true, range });
    expect(replayReducer(s1, { type: 'tick', elapsedMs: 1000 })).toEqual({ instant: range.to, playing: false, range });
  });

  test('tick sans lecture : rien ne bouge', () => {
    const s = { instant: t, playing: false, range };
    expect(replayReducer(s, { type: 'tick', elapsedMs: 1000 })).toBe(s);
  });

  test('pause garde l\'instant ; live revient au direct', () => {
    const playing = { instant: t, playing: true, range };
    expect(replayReducer(playing, { type: 'pause' })).toEqual({ instant: t, playing: false, range });
    expect(replayReducer(playing, { type: 'live' })).toEqual(direct);
  });

  test('pick pendant la lecture : met en pause', () => {
    expect(replayReducer({ instant: t, playing: true, range }, { type: 'pick', ts: t - 5000 })).toMatchObject({ instant: t - 5000, playing: false });
  });
});

describe('gestes et textes du rejeu', () => {
  test('replayInstant : instant de l\'échantillon en détail, instant cliqué sur des buckets ≥ 1 min (7 j, 30 j)', () => {
    expect(replayInstant(1000, 3456.7, 5000)).toBe(1000);
    expect(replayInstant(1000, 3456.7, 60_000)).toBe(1000);
    expect(replayInstant(3_600_000, 4_100_123.4, 3_600_000)).toBe(4_100_123);
  });

  test('ClickDelay : un clic simple fige après le délai ; un double-clic (retour du zoom) ne fige rien', () => {
    vi.useFakeTimers();
    const fired: number[] = [];
    const d = new ClickDelay(250, (ts) => fired.push(ts));
    d.click(1);
    vi.advanceTimersByTime(249);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual([1]);
    d.click(2);
    d.click(2); // second clic du double-clic
    d.cancel(); // dblclick
    vi.advanceTimersByTime(1000);
    expect(fired).toEqual([1]);
    d.click(3);
    d.dispose();
    vi.advanceTimersByTime(1000);
    expect(fired).toEqual([1]);
    vi.useRealTimers();
  });

  test('replayEmptyText : trou d\'enregistrement ou processus sous les seuils', () => {
    const at = (recorded: boolean): ProcTreeAt => ({ ts: 0, source: 'detail', procs: [], recorded, omitted: 0 });
    expect(replayEmptyText(at(false))).toMatch(/^Trou d'enregistrement/);
    expect(replayEmptyText(at(true))).toBe("Aucun processus au-dessus des seuils d'enregistrement à cet instant");
  });
});

describe('tuiles du détail à l\'instant survolé (séries du graphe)', () => {
  const h = { ts: [0, 5000, 10_000], rssKB: [100, 200, null], swapKB: [1, 2, 3], cpu: [5, 6, 7], procCount: [3, 4, 5] };
  test('point le plus proche, aucune requête : valeurs des séries déjà chargées', () => {
    expect(tilesAt(h, 4000)).toEqual({ procCount: 4, rssKB: 200, swapKB: 2, cpu: 6 });
    expect(tilesAt(h, 0)).toEqual({ procCount: 3, rssKB: 100, swapKB: 1, cpu: 5 });
    expect(tilesAt(h, 9000)).toMatchObject({ rssKB: null, swapKB: 3 }); // trou dans la série
  });
  test('sans nombre de processus (séries par minute) ou hors de la plage chargée : null', () => {
    expect(tilesAt({ ...h, procCount: undefined }, 5000)?.procCount).toBeNull();
    expect(tilesAt(h, 60_000)).toBeNull();
    expect(tilesAt(h, -20_000)).toBeNull();
    expect(tilesAt(undefined, 0)).toBeNull();
    expect(tilesAt({ ts: [], rssKB: [], swapKB: [], cpu: [] }, 0)).toBeNull();
    expect(tilesAt({ ts: [7], rssKB: [1], swapKB: [0], cpu: [0] }, 7)).toMatchObject({ rssKB: 1 });
  });
});
