// src/renderer/src/useReplay.ts — rejeu « voyage dans le temps » du détail : adaptateur React du ReplayController
import { useEffect, useMemo, useReducer, useRef } from 'react';
import type { ProcTreeAt, TimeRange } from '../../core/types';
import { isLive } from './history';
import { ReplayController } from './replayController';

export { replayReducer, type ReplayAction, type ReplayState } from './replayController';

export interface Replay {
  /** null = direct */
  instant: number | null;
  playing: boolean;
  /** undefined = chargement, null = pas de base */
  tree: ProcTreeAt | null | undefined;
  /** Fige l'instant (met la lecture en pause). */
  pick: (ts: number) => void;
  /** Avance de ×60 chaque seconde jusqu'à range.to ; une requête à la fois ; arrêtée tant que la fenêtre est réduite. */
  play: (range: TimeRange) => void;
  pause: () => void;
  /** Revient au direct. */
  live: () => void;
}

/** Rejeu du groupe ; changer de groupe remet au direct dès ce rendu (aucune image de l'ancien groupe). */
export function useReplay(groupId: string): Replay {
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  const ref = useRef<ReplayController | null>(null);
  ref.current ??= new ReplayController(groupId, {
    fetch: (key, ts) => window.procWatch.history.procTree(key, ts),
    isLive,
    onChange: bump,
  });
  const c = ref.current;
  c.setGroup(groupId);
  useEffect(() => () => c.dispose(), [c]);
  const { instant, playing } = c.state;
  const tree = c.tree;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => ({ instant, playing, tree, pick: c.pick, play: c.play, pause: c.pause, live: c.live }), [instant, playing, tree, c, version]);
}
