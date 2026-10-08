// src/renderer/src/useReplay.ts — état du rejeu « voyage dans le temps » du détail (instant figé, lecture ×60, requêtes)
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ProcTreeAt, TimeRange } from '../../core/types';
import { nextReplayTs } from './replay';

export interface Replay {
  /** null = direct */
  instant: number | null;
  playing: boolean;
  /** undefined = chargement, null = pas de base */
  tree: ProcTreeAt | null | undefined;
  /** Fige l'instant (met la lecture en pause). */
  pick: (ts: number) => void;
  /** Avance de ×60 chaque seconde jusqu'à range.to ; une requête à la fois (tick sauté si la précédente n'est pas revenue). */
  play: (range: TimeRange) => void;
  pause: () => void;
  /** Revient au direct. */
  live: () => void;
}

export interface ReplayState { instant: number | null; playing: boolean; range: TimeRange | null }
export type ReplayAction =
  | { type: 'pick'; ts: number } | { type: 'play'; range: TimeRange } | { type: 'tick'; elapsedMs: number }
  | { type: 'pause' } | { type: 'live' };

const DIRECT: ReplayState = { instant: null, playing: false, range: null };

/** Réduction pure de l'état ; `tick` utilise nextReplayTs et arrête la lecture au bout de la plage. */
export function replayReducer(s: ReplayState, a: ReplayAction): ReplayState {
  switch (a.type) {
    case 'pick':
      return { ...s, instant: a.ts, playing: false };
    case 'play': {
      const i = s.instant;
      // Instant hors plage (ou déjà au bout) : la lecture repart du début.
      const start = i === null || i < a.range.from || i >= a.range.to ? a.range.from : i;
      return { instant: start, playing: true, range: a.range };
    }
    case 'tick': {
      if (!s.playing || s.instant === null || !s.range) return s;
      const n = nextReplayTs(s.instant, s.range, a.elapsedMs);
      return { ...s, instant: n.ts, playing: !n.done };
    }
    case 'pause':
      return s.playing ? { ...s, playing: false } : s;
    case 'live':
      return DIRECT;
  }
}

const TICK_MS = 1000;

/** Rejeu du groupe ; changer de groupe remet au direct. */
export function useReplay(groupId: string): Replay {
  const [s, dispatch] = useReducer(replayReducer, DIRECT);
  const [tree, setTree] = useState<ProcTreeAt | null | undefined>(undefined);
  const inflight = useRef(false);
  const reqId = useRef(0);

  // Changer de groupe remet au direct.
  useEffect(() => dispatch({ type: 'live' }), [groupId]);

  useEffect(() => {
    if (s.instant === null) {
      reqId.current++;
      inflight.current = false;
      setTree(undefined);
      return;
    }
    const id = ++reqId.current;
    inflight.current = true;
    // L'arbre précédent reste affiché pendant la requête (pas de clignotement pendant la lecture).
    window.procWatch.history.procTree(groupId, Math.round(s.instant)).then(
      (t) => {
        if (id !== reqId.current) return;
        inflight.current = false;
        setTree(t);
      },
      () => {
        if (id !== reqId.current) return;
        inflight.current = false;
        setTree(null);
      },
    );
  }, [groupId, s.instant]);

  useEffect(() => {
    if (!s.playing) return;
    const timer = setInterval(() => {
      if (!inflight.current) dispatch({ type: 'tick', elapsedMs: TICK_MS });
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [s.playing]);

  const pick = useCallback((ts: number) => dispatch({ type: 'pick', ts }), []);
  const play = useCallback((range: TimeRange) => dispatch({ type: 'play', range }), []);
  const pause = useCallback(() => dispatch({ type: 'pause' }), []);
  const live = useCallback(() => dispatch({ type: 'live' }), []);
  return useMemo(() => ({ instant: s.instant, playing: s.playing, tree, pick, play, pause, live }), [s.instant, s.playing, tree, pick, play, pause, live]);
}
