// src/renderer/src/useReplay.ts — rejeu « voyage dans le temps » du détail (survol, instant figé, lecture ×60) : adaptateur React du ReplayController
import { useEffect, useMemo, useReducer, useRef } from 'react';
import type { GroupHistory, ProcTreeAt, TimeRange } from '../../core/types';
import type { TilesAt } from './components/DetailTiles';
import { isLive, onLiveResume } from './history';
import { tilesAt } from './replay';
import { ReplayController } from './replayController';

export { replayReducer, type ReplayAction, type ReplayState } from './replayController';

export interface Replay {
  /** Instant affiché (survol, sinon instant figé ; pendant la lecture, l'instant joué) ; null = direct. */
  instant: number | null;
  /** Instant figé par un clic (null : aucun). */
  pinned: number | null;
  playing: boolean;
  /** undefined = chargement, null = pas de base */
  tree: ProcTreeAt | null | undefined;
  /** Tuiles à l'instant affiché, lues dans les séries du graphe ; null en direct. */
  tiles: TilesAt | null;
  /** Fige l'instant (met la lecture en pause). */
  pick: (ts: number) => void;
  /** Avance de ×60 chaque seconde jusqu'à range.to ; une requête à la fois ; arrêtée tant que la fenêtre est réduite. */
  play: (range: TimeRange) => void;
  pause: () => void;
  /** Revient au direct. */
  live: () => void;
  /** Survol du graphe : instant pointé, null à la sortie de la souris. */
  hover: (ts: number | null) => void;
  /** Séries chargées du graphe Historique (pour les tuiles). */
  setSeries: (h: GroupHistory | null) => void;
}

/** Rejeu du groupe ; changer de groupe remet au direct dès ce rendu (aucune image de l'ancien groupe). */
export function useReplay(groupId: string): Replay {
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  const ref = useRef<ReplayController | null>(null);
  const frame = useRef(0);
  ref.current ??= new ReplayController(groupId, {
    fetch: (key, ts) => window.procWatch.history.procTree(key, ts),
    isLive,
    onLiveResume,
    // Un rendu par image au plus, même si la souris envoie plus d'événements que l'écran n'affiche d'images.
    onChange: () => {
      if (!frame.current) frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        bump();
      });
    },
  });
  const c = ref.current;
  c.setGroup(groupId);
  useEffect(
    () => () => {
      c.dispose();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    },
    [c],
  );
  const instant = c.shown;
  const { instant: pinned, playing } = c.state;
  const tree = c.tree;
  const series = c.series;
  return useMemo(
    () => ({
      instant,
      pinned,
      playing,
      tree,
      tiles: instant === null ? null : { ts: instant, values: tilesAt(series, instant) },
      pick: c.pick,
      play: c.play,
      pause: c.pause,
      live: c.live,
      hover: c.hover,
      setSeries: c.setSeries,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [instant, pinned, playing, tree, series, c, version],
  );
}
