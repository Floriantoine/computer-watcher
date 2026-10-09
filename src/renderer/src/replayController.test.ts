import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ProcTreeAt } from '../../core/types';
import { REPLAY_CACHE_SIZE, ReplayController } from './replayController';

const T = 1_000_000;
const range = { from: T, to: T + 10 * 60_000 };
const treeAt = (ts: number): ProcTreeAt => ({ ts, source: 'detail', procs: [], recorded: true, omitted: 0 });

/** fetch simulé : chaque appel reste en attente jusqu'à resolve(i). */
function setup(live = { v: true }) {
  const calls: { key: string; ts: number; resolve: (t: ProcTreeAt | null) => void }[] = [];
  const fetch = vi.fn((key: string, ts: number) => new Promise<ProcTreeAt | null>((resolve) => calls.push({ key, ts, resolve })));
  const onChange = vi.fn();
  const resume = new Set<() => void>();
  const onLiveResume = (cb: () => void) => {
    resume.add(cb);
    return () => void resume.delete(cb);
  };
  const c = new ReplayController('g', { fetch, isLive: () => live.v, onChange, onLiveResume });
  const restore = () => {
    live.v = true;
    for (const f of resume) f();
  };
  return { c, calls, fetch, onChange, live, restore, resume };
}
const flush = () => Promise.resolve().then(() => Promise.resolve());

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('une requête à la fois : le tick est sauté tant que la précédente n\'est pas revenue', async () => {
  const { c, calls } = setup();
  c.play(range);
  expect(calls.map((x) => x.ts)).toEqual([T]);
  vi.advanceTimersByTime(3000);
  expect(calls).toHaveLength(1);
  expect(c.state.instant).toBe(T);
  calls[0].resolve(treeAt(T));
  await flush();
  vi.advanceTimersByTime(1000);
  expect(calls.map((x) => x.ts)).toEqual([T, T + 60_000]);
});

test('une requête à la fois aussi pour le clic : le nouvel instant part au retour de la précédente', async () => {
  const { c, calls } = setup();
  c.pick(T);
  c.pick(T + 5000);
  expect(calls.map((x) => x.ts)).toEqual([T]);
  calls[0].resolve(treeAt(T));
  await flush();
  // L'arbre de T s'affiche (le bandeau montre son instant) ; T+5000 part après le délai de 200 ms.
  expect(c.tree?.ts).toBe(T);
  vi.advanceTimersByTime(200);
  expect(calls.map((x) => x.ts)).toEqual([T, T + 5000]);
  calls[1].resolve(treeAt(T + 5000));
  await flush();
  expect(c.tree?.ts).toBe(T + 5000);
});

test('fenêtre réduite ou cachée : la lecture n\'avance plus, et reprend à la restauration', async () => {
  const { c, calls, live } = setup();
  c.play(range);
  calls[0].resolve(treeAt(T));
  await flush();
  live.v = false;
  vi.advanceTimersByTime(5000);
  expect(c.state.instant).toBe(T);
  expect(calls).toHaveLength(1);
  live.v = true;
  vi.advanceTimersByTime(1000);
  expect(c.state.instant).toBe(T + 60_000);
});

test('minuterie nettoyée : pause, fin de plage, live, dispose', async () => {
  const { c, calls } = setup();
  c.play(range);
  expect(vi.getTimerCount()).toBe(1);
  c.pause();
  expect(vi.getTimerCount()).toBe(0);
  c.play({ from: T, to: T + 60_000 });
  calls.at(-1)!.resolve(treeAt(T));
  await flush();
  vi.advanceTimersByTime(1000); // atteint la fin
  expect(c.state).toMatchObject({ instant: T + 60_000, playing: false });
  expect(vi.getTimerCount()).toBe(0);
  c.play(range);
  c.live();
  expect(vi.getTimerCount()).toBe(0);
  expect(c.tree).toBeUndefined();
  c.play(range);
  c.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

test('changement de groupe : retour au direct immédiat, requête en cours abandonnée', async () => {
  const { c, calls, onChange } = setup();
  c.pick(T);
  onChange.mockClear();
  expect(c.setGroup('g')).toBe(false);
  expect(c.setGroup('h')).toBe(true);
  expect(c.state).toEqual({ instant: null, playing: false, range: null });
  calls[0].resolve(treeAt(T));
  await flush();
  expect(c.tree).toBeUndefined();
  expect(onChange).not.toHaveBeenCalled(); // appelé pendant le rendu : pas de notification
  c.pick(T + 1);
  vi.advanceTimersByTime(200); // délai minimal entre deux requêtes
  expect(calls.at(-1)).toMatchObject({ key: 'h', ts: T + 1 });
});

test('échec de la requête : historique indisponible (null)', async () => {
  const { c } = setup();
  const failing = new ReplayController('g', { fetch: () => Promise.reject(new Error('x')), isLive: () => true, onChange: () => {} });
  failing.pick(T);
  await flush();
  expect(failing.tree).toBeNull();
  c.dispose();
});

describe('survol du graphe (aperçu)', () => {
  test('survol : aperçu de l\'instant pointé sans clic ; sortie : retour immédiat au direct', async () => {
    const { c, calls } = setup();
    c.hover(T);
    expect(c.shown).toBe(T);
    expect(c.state.instant).toBeNull(); // rien de figé
    expect(calls.map((x) => x.ts)).toEqual([T]);
    calls[0].resolve(treeAt(T));
    await flush();
    expect(c.tree?.ts).toBe(T);
    c.hover(null);
    expect(c.shown).toBeNull();
    expect(c.tree).toBeUndefined();
  });

  test('throttle : au plus une requête toutes les 200 ms, la dernière position gagne', async () => {
    const { c, calls } = setup();
    c.hover(T);
    calls[0].resolve(treeAt(T));
    await flush();
    // Balayage : 20 positions en 50 ms.
    for (let i = 1; i <= 20; i++) {
      c.hover(T + i * 1000);
      vi.advanceTimersByTime(2.5);
    }
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(150); // 200 ms depuis la première requête
    expect(calls.map((x) => x.ts)).toEqual([T, T + 20_000]);
    calls[1].resolve(treeAt(T + 20_000));
    await flush();
    vi.advanceTimersByTime(1000);
    expect(calls).toHaveLength(2); // rien de plus : la position n'a pas bougé
    expect(c.tree?.ts).toBe(T + 20_000);
  });

  test('throttle sur un balayage continu de 1 s : une requête toutes les 200 ms, même avec des réponses immédiates', async () => {
    const { c, calls, fetch } = setup();
    const sent: number[] = [];
    fetch.mockImplementation((key: string, ts: number) => {
      sent.push(Date.now());
      return new Promise<ProcTreeAt | null>((resolve) => calls.push({ key, ts, resolve }));
    });
    for (let ms = 0; ms < 1000; ms += 8) {
      c.hover(T + ms * 100);
      calls.at(-1)?.resolve(treeAt(calls.at(-1)!.ts));
      await flush();
      vi.advanceTimersByTime(8);
    }
    // 0, 200, …, 800 ms puis 1000 ms (fin du balayage) : 6 requêtes, espacées d'au moins 200 ms, sur 125 positions.
    const times = sent.map((x) => x - sent[0]);
    expect(times).toEqual([0, 200, 400, 600, 800, 1000]);
    expect(calls.at(-1)!.ts).toBe(T + 99_200); // dernière position
  });

  test('même échantillon que la requête en vol : pas de nouvelle requête, sa réponse s\'affiche', async () => {
    const { c, calls } = setup();
    c.hover(T);
    c.hover(T + 1000); // en attente
    c.hover(T); // revient sur l'échantillon en vol
    vi.advanceTimersByTime(1000);
    expect(calls).toHaveLength(1);
    calls[0].resolve(treeAt(T));
    await flush();
    vi.advanceTimersByTime(1000);
    expect(calls).toHaveLength(1);
    expect(c.tree?.ts).toBe(T);
  });

  test('cache : un instant déjà chargé s\'affiche sans requête', async () => {
    const { c, calls } = setup();
    c.hover(T);
    calls[0].resolve(treeAt(T));
    await flush();
    vi.advanceTimersByTime(200);
    c.hover(T + 2000);
    calls[1].resolve(treeAt(T + 2000));
    await flush();
    c.hover(null);
    vi.advanceTimersByTime(200);
    c.hover(T);
    expect(c.tree?.ts).toBe(T); // tout de suite, depuis le cache
    vi.advanceTimersByTime(1000);
    expect(calls).toHaveLength(2);
  });

  test('balayage sur des instants en cache : l\'arbre change au plus une fois toutes les 200 ms (dernière position)', async () => {
    const { c, calls } = setup();
    for (const ts of [T, T + 1000]) {
      c.hover(ts);
      vi.advanceTimersByTime(200);
      calls.at(-1)!.resolve(treeAt(ts));
      await flush();
    }
    vi.advanceTimersByTime(200);
    let changes = 0;
    let last = c.tree;
    for (let ms = 0; ms < 1000; ms += 10) {
      c.hover(ms % 20 ? T + 1000 : T);
      vi.advanceTimersByTime(10);
      if (c.tree !== last) changes++;
      last = c.tree;
    }
    expect(calls).toHaveLength(2); // aucune requête
    expect(changes).toBeLessThanOrEqual(6);
    vi.advanceTimersByTime(200);
    expect(c.tree?.ts).toBe(T + 1000); // la dernière position gagne
  });

  test('cache LRU borné : le plus ancien usage est évincé', async () => {
    const { c, calls } = setup();
    const load = async (ts: number) => {
      c.hover(ts);
      vi.advanceTimersByTime(200);
      const call = calls.at(-1)!;
      if (call.ts === ts) {
        call.resolve(treeAt(ts));
        await flush();
      }
    };
    for (let i = 0; i < REPLAY_CACHE_SIZE; i++) await load(T + i);
    await load(T); // T redevient le plus récent
    await load(T + 1000); // évince T + 1
    const n = calls.length;
    c.hover(T);
    vi.advanceTimersByTime(200);
    expect(calls).toHaveLength(n); // T toujours en cache
    c.hover(T + 1);
    vi.advanceTimersByTime(200);
    expect(calls).toHaveLength(n + 1);
  });

  test('réponse périmée ignorée : retour au direct ou instant servi par le cache pendant la requête', async () => {
    const { c, calls } = setup();
    c.hover(T);
    calls[0].resolve(treeAt(T));
    await flush();
    vi.advanceTimersByTime(200);
    c.hover(T + 5000);
    c.hover(T); // cache (servi au prochain créneau de 200 ms) : la requête en cours devient périmée
    calls[1].resolve(treeAt(T + 5000));
    await flush();
    expect(c.tree?.ts).toBe(T);
    vi.advanceTimersByTime(200);
    expect(c.tree?.ts).toBe(T);
    vi.advanceTimersByTime(200);
    c.hover(T + 9000);
    c.hover(null);
    calls[2].resolve(treeAt(T + 9000));
    await flush();
    expect(c.tree).toBeUndefined();
  });

  test('instant figé : la sortie de la souris y revient ; un clic ailleurs le déplace ; live (Échap) le libère', async () => {
    const { c, calls } = setup();
    c.hover(T);
    c.pick(T);
    calls[0].resolve(treeAt(T));
    await flush();
    vi.advanceTimersByTime(200);
    c.hover(T + 3000);
    expect(c.shown).toBe(T + 3000); // le survol reste un aperçu
    c.hover(null);
    expect(c.shown).toBe(T); // sortie : retour à l'instant figé
    expect(c.tree?.ts).toBe(T); // depuis le cache
    c.pick(T + 7000);
    expect(c.state.instant).toBe(T + 7000);
    c.live();
    expect(c.shown).toBeNull();
    expect(c.state.instant).toBeNull();
  });

  test('lecture : le survol ne déplace pas l\'instant joué', () => {
    const { c } = setup();
    c.pick(T);
    c.play(range);
    c.hover(T + 99_000);
    expect(c.shown).toBe(T);
  });

  test('fenêtre cachée : aucune requête ; la position en attente part à la restauration', async () => {
    const { c, calls, live, restore } = setup();
    live.v = false;
    c.hover(T);
    vi.advanceTimersByTime(5000);
    expect(calls).toHaveLength(0);
    restore();
    expect(calls.map((x) => x.ts)).toEqual([T]);
  });

  test('dispose : minuterie du throttle et abonnement à la reprise libérés', async () => {
    const { c, calls, resume } = setup();
    c.hover(T);
    calls[0].resolve(treeAt(T));
    await flush();
    c.hover(T + 1);
    expect(vi.getTimerCount()).toBe(1);
    c.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(resume.size).toBe(0);
  });

  test('changement de groupe : aperçu et cache remis à zéro', async () => {
    const { c, calls } = setup();
    c.hover(T);
    calls[0].resolve(treeAt(T));
    await flush();
    c.setGroup('h');
    expect(c.shown).toBeNull();
    c.hover(T);
    vi.advanceTimersByTime(200);
    expect(calls.at(-1)).toMatchObject({ key: 'h', ts: T });
  });
});

describe('cache par horodatage d\'échantillon (rafraîchissement du graphe)', () => {
  const series = (from: number, step: number, n = 10) => ({ ts: Array.from({ length: n }, (_, i) => from + i * step), rssKB: [], swapKB: [], cpu: [] });
  test('les débuts de bucket glissent au rafraîchissement : l\'arbre de l\'échantillon reste servi par le cache', async () => {
    const { c, calls } = setup();
    c.setSeries(series(T, 5000));
    c.hover(T + 5000);
    calls[0].resolve(treeAt(T + 6200)); // échantillon réel
    await flush();
    vi.advanceTimersByTime(200);
    // Rafraîchissement : la grille a glissé de 1,3 s.
    c.setSeries(series(T + 1300, 5000));
    c.hover(T + 6300);
    vi.advanceTimersByTime(200);
    expect(calls).toHaveLength(1);
    expect(c.tree?.ts).toBe(T + 6200);
  });
  test('échantillon voisin (plus d\'un demi-pas) : nouvelle requête', async () => {
    const { c, calls } = setup();
    c.setSeries(series(T, 5000));
    c.hover(T + 5000);
    calls[0].resolve(treeAt(T + 5000));
    await flush();
    vi.advanceTimersByTime(200);
    c.hover(T + 8000);
    vi.advanceTimersByTime(200);
    expect(calls).toHaveLength(2);
  });
  test('buckets d\'une heure (7 j) : tolérance bornée à la minute des arbres enregistrés', async () => {
    const { c, calls } = setup();
    c.setSeries(series(T, 3_600_000));
    c.hover(T + 600_000);
    calls[0].resolve(treeAt(T + 600_000));
    await flush();
    vi.advanceTimersByTime(200);
    c.hover(T + 620_000); // même minute
    vi.advanceTimersByTime(200);
    expect(calls).toHaveLength(1);
    c.hover(T + 700_000); // une autre minute
    vi.advanceTimersByTime(200);
    expect(calls).toHaveLength(2);
  });
});
