import { describe, expect, test, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../core/config';
import { FOCUS_REFRESH_MS, MAX_SEEN_IDS } from '../core/alerts';
import { createAlertOpener, createFocusWriter, initSeenUpTo, keepSeenUpTo, markSeen, unseenFilter } from './alerts';

describe('seenUpTo', () => {
  test('absent (0) : initialisé à maintenant (pas de déluge de vieilles alertes au premier lancement)', () => {
    expect(initSeenUpTo(DEFAULT_CONFIG, 5000)?.alerts.seenUpTo).toBe(5000);
    const set = { ...DEFAULT_CONFIG, alerts: { ...DEFAULT_CONFIG.alerts, seenUpTo: 42 } };
    expect(initSeenUpTo(set, 5000)).toBeNull(); // déjà initialisé : rien à écrire
  });

  test('markSeen : seenUpTo avance seulement, refuse le futur lointain et les valeurs invalides', () => {
    const c = { ...DEFAULT_CONFIG, alerts: { ...DEFAULT_CONFIG.alerts, seenUpTo: 1000 } };
    const none = () => null;
    expect(markSeen(c, { upTo: 2000 }, 10_000, none)?.alerts.seenUpTo).toBe(2000);
    expect(markSeen(c, { upTo: 500 }, 10_000, none)).toBeNull(); // recul : rien
    expect(markSeen(c, { upTo: 10_000 + 120_000 }, 10_000, none)).toBeNull();
    for (const bad of [{ upTo: Number.NaN }, { upTo: -1 }, { upTo: '2000' }, null, 5, { ids: [0] }, { ids: ['1'] }, { ids: 'x' }]) {
      expect(markSeen(c, bad, 10_000, none)).toBeNull();
    }
  });

  test('markSeen : ids fermés gardés au-dessus de seenUpTo (après redémarrage, ils ne reviennent pas), élagués sinon', () => {
    const c = { ...DEFAULT_CONFIG, alerts: { ...DEFAULT_CONFIG.alerts, seenUpTo: 1000, seenIds: [7] } };
    const ts = new Map([[7, 1500], [8, 1800], [9, 2500]]);
    const tsOf = (ids: number[]) => new Map(ids.flatMap((i) => (ts.has(i) ? [[i, ts.get(i)!] as [number, number]] : [])));
    expect(markSeen(c, { ids: [9] }, 10_000, tsOf)?.alerts).toMatchObject({ seenUpTo: 1000, seenIds: [7, 9] });
    // seenUpTo passe 1800 : 7 et 8 couverts, 9 reste
    expect(markSeen(c, { upTo: 1800, ids: [8, 9] }, 10_000, tsOf)?.alerts).toMatchObject({ seenUpTo: 1800, seenIds: [9] });
    // id inconnu de la base (base vidée) : retiré ; base illisible (tsOf null) : gardé
    expect(markSeen(c, { ids: [42] }, 10_000, tsOf)).toBeNull(); // rien ne change
    expect(markSeen(c, { ids: [42] }, 10_000, () => null)?.alerts.seenIds).toEqual([7, 42]);
  });

  test('markSeen : au plus MAX_SEEN_IDS ids, les plus récents gardés', () => {
    const many = Array.from({ length: MAX_SEEN_IDS }, (_, i) => i + 1);
    const c = { ...DEFAULT_CONFIG, alerts: { ...DEFAULT_CONFIG.alerts, seenUpTo: 0.5, seenIds: many } };
    const r = markSeen(c, { ids: [MAX_SEEN_IDS + 1] }, 10_000, () => null)!;
    expect(r.alerts.seenIds).toHaveLength(MAX_SEEN_IDS);
    expect(r.alerts.seenIds[0]).toBe(2);
    expect(r.alerts.seenIds.at(-1)).toBe(MAX_SEEN_IDS + 1);
  });

  test('config:set ne fait jamais reculer seenUpTo (réglages ouverts avec une copie plus ancienne)', () => {
    const cur = { ...DEFAULT_CONFIG, alerts: { ...DEFAULT_CONFIG.alerts, seenUpTo: 3000 } };
    const next = { ...DEFAULT_CONFIG, alerts: { ...DEFAULT_CONFIG.alerts, seenUpTo: 1000, desktopMinIntervalMin: 9 } };
    expect(keepSeenUpTo(next, cur).alerts).toEqual({ ...next.alerts, seenUpTo: 3000 });
    // seenIds : ceux du main (les Réglages ne les modifient pas)
    const cur2 = { ...cur, alerts: { ...cur.alerts, seenIds: [4, 5] } };
    expect(keepSeenUpTo(next, cur2).alerts.seenIds).toEqual([4, 5]);
  });
});

describe('unseenFilter', () => {
  test('types avec pop-up (canal ≠ none) et ids déjà fermés', () => {
    const c = { ...DEFAULT_CONFIG, alerts: { ...DEFAULT_CONFIG.alerts, seenIds: [3], channels: { ...DEFAULT_CONFIG.alerts.channels, leak: 'none' as const } } };
    const f = unseenFilter(c);
    expect(f.types).not.toContain('leak');
    expect(f.types).toContain('pressure');
    expect(f.exclude).toEqual([3]);
  });
});

describe('createFocusWriter', () => {
  test('focus : écrit tout de suite puis toutes les FOCUS_REFRESH_MS ; perte du focus : écrit focused:false et arrête', () => {
    vi.useFakeTimers();
    try {
      let t = 1000;
      const writes: string[] = [];
      const w = createFocusWriter({ write: (s) => writes.push(s), now: () => t });
      w.set(true);
      expect(JSON.parse(writes[0]!)).toEqual({ focused: true, ts: 1000 });
      t += FOCUS_REFRESH_MS;
      vi.advanceTimersByTime(FOCUS_REFRESH_MS);
      expect(writes).toHaveLength(2);
      expect(JSON.parse(writes[1]!)).toEqual({ focused: true, ts: 1000 + FOCUS_REFRESH_MS });
      w.set(true); // déjà focalisé : pas de second intervalle
      vi.advanceTimersByTime(FOCUS_REFRESH_MS);
      expect(writes).toHaveLength(4);
      w.set(false);
      expect(JSON.parse(writes[4]!)).toMatchObject({ focused: false });
      vi.advanceTimersByTime(10 * FOCUS_REFRESH_MS);
      expect(writes).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });

  test('écriture qui lève : ignorée', () => {
    const w = createFocusWriter({ write: () => { throw new Error('EROFS'); }, now: () => 1 });
    expect(() => w.set(true)).not.toThrow();
    w.set(false);
  });
});

describe('createAlertOpener', () => {
  test('alerte reçue avant que le renderer soit prêt : mise en attente, rendue une fois', () => {
    const send = vi.fn();
    const o = createAlertOpener(send);
    o.open(42);
    expect(send).toHaveBeenCalledWith(42); // envoyée aussi (perdue si la page charge encore)
    expect(o.take()).toBe(42);
    expect(o.take()).toBeNull();
  });
});
