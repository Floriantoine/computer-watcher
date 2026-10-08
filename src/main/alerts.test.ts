import { describe, expect, test, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../core/config';
import { FOCUS_REFRESH_MS } from '../core/alerts';
import { createAlertOpener, createFocusWriter, initSeenUpTo, keepSeenUpTo, markSeen } from './alerts';

describe('seenUpTo', () => {
  test('absent (0) : initialisé à maintenant (pas de déluge de vieilles alertes au premier lancement)', () => {
    expect(initSeenUpTo(DEFAULT_CONFIG, 5000)?.alerts.seenUpTo).toBe(5000);
    const set = { ...DEFAULT_CONFIG, alerts: { ...DEFAULT_CONFIG.alerts, seenUpTo: 42 } };
    expect(initSeenUpTo(set, 5000)).toBeNull(); // déjà initialisé : rien à écrire
  });

  test('markSeen : avance seulement, refuse le futur lointain et les valeurs invalides', () => {
    const c = { ...DEFAULT_CONFIG, alerts: { ...DEFAULT_CONFIG.alerts, seenUpTo: 1000 } };
    expect(markSeen(c, 2000, 10_000)?.alerts.seenUpTo).toBe(2000);
    expect(markSeen(c, 500, 10_000)).toBeNull(); // recul : rien
    expect(markSeen(c, 10_000 + 120_000, 10_000)).toBeNull();
    for (const bad of [Number.NaN, -1, '2000', null]) expect(markSeen(c, bad, 10_000)).toBeNull();
  });

  test('config:set ne fait jamais reculer seenUpTo (réglages ouverts avec une copie plus ancienne)', () => {
    const cur = { ...DEFAULT_CONFIG, alerts: { ...DEFAULT_CONFIG.alerts, seenUpTo: 3000 } };
    const next = { ...DEFAULT_CONFIG, alerts: { ...DEFAULT_CONFIG.alerts, seenUpTo: 1000, desktopMinIntervalMin: 9 } };
    expect(keepSeenUpTo(next, cur).alerts).toEqual({ ...next.alerts, seenUpTo: 3000 });
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
