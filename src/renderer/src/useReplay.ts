// src/renderer/src/useReplay.ts — rejeu « voyage dans le temps » du détail (survol, instant figé, lecture ×60) : adaptateur React du ReplayController
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { isLive, onLiveResume } from './history';
import { ReplayController } from './replayController';

export { replayReducer, type ReplayAction, type ReplayState } from './replayController';

/**
 * Contrôleur du rejeu et abonnement à ses changements (au plus une notification par image). Chaque composant lit
 * seulement ce qu'il affiche (`useReplaySelect`) : un survol re-rend les tuiles, pas tout le détail.
 */
export interface ReplayStore {
  c: ReplayController;
  subscribe: (cb: () => void) => () => void;
}

/** Rejeu du groupe ; changer de groupe remet au direct dès ce rendu (aucune image de l'ancien groupe). */
export function useReplayStore(groupId: string): ReplayStore {
  const ref = useRef<(ReplayStore & { frame: number; listeners: Set<() => void> }) | null>(null);
  if (!ref.current) {
    const listeners = new Set<() => void>();
    const s = {
      frame: 0,
      listeners,
      subscribe: (cb: () => void) => {
        listeners.add(cb);
        return () => void listeners.delete(cb);
      },
    } as ReplayStore & { frame: number; listeners: Set<() => void> };
    s.c = new ReplayController(groupId, {
      fetch: (key, ts) => window.procWatch.history.procTree(key, ts),
      isLive,
      onLiveResume,
      // Une notification par image au plus, même si la souris envoie plus d'événements que l'écran n'affiche d'images.
      onChange: () => {
        if (!s.frame)
          s.frame = requestAnimationFrame(() => {
            s.frame = 0;
            for (const f of listeners) f();
          });
      },
    });
    ref.current = s;
  }
  const s = ref.current;
  s.c.setGroup(groupId);
  useEffect(
    () => () => {
      s.c.dispose();
      cancelAnimationFrame(s.frame);
      s.frame = 0;
    },
    [s],
  );
  return s;
}

/** Valeur lue dans le contrôleur ; `sel` doit renvoyer une valeur primitive ou une référence stable. */
export function useReplaySelect<T>(s: ReplayStore, sel: (c: ReplayController) => T): T {
  return useSyncExternalStore(s.subscribe, () => sel(s.c));
}
