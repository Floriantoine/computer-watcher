// src/renderer/src/replayController.ts — rejeu « voyage dans le temps » : état, minuterie et requêtes, hors de React (testé)
import type { ProcTreeAt, TimeRange } from '../../core/types';
import { nextReplayTs } from './replay';

export interface ReplayState { instant: number | null; playing: boolean; range: TimeRange | null }
export type ReplayAction =
  | { type: 'pick'; ts: number } | { type: 'play'; range: TimeRange } | { type: 'tick'; elapsedMs: number }
  | { type: 'pause' } | { type: 'live' };

export const DIRECT: ReplayState = { instant: null, playing: false, range: null };

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
      return s === DIRECT ? s : DIRECT;
  }
}

export interface ReplayDeps {
  fetch: (groupKey: string, ts: number) => Promise<ProcTreeAt | null>;
  /** Faux quand la fenêtre est réduite ou cachée : la lecture n'avance plus (aucune requête) jusqu'à la restauration. */
  isLive: () => boolean;
  /** État ou arbre changé (hors setGroup, appelé pendant le rendu). */
  onChange: () => void;
}

export const REPLAY_TICK_MS = 1000;

/**
 * Lecture ×60 : une minuterie d'une seconde, active seulement pendant la lecture. Une requête à la fois (tick sauté tant
 * que la précédente n'est pas revenue) ; réponse d'un instant ou d'un groupe périmé ignorée.
 */
export class ReplayController {
  state: ReplayState = DIRECT;
  /** undefined = chargement (ou direct), null = pas de base. */
  tree: ProcTreeAt | null | undefined = undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight = false;
  private reqId = 0;

  constructor(private groupId: string, private deps: ReplayDeps) {}

  pick = (ts: number): void => this.dispatch({ type: 'pick', ts });
  play = (range: TimeRange): void => this.dispatch({ type: 'play', range });
  pause = (): void => this.dispatch({ type: 'pause' });
  live = (): void => this.dispatch({ type: 'live' });

  /** Nouveau groupe : retour au direct immédiat, sans notification (appelé pendant le rendu). Vrai si le groupe a changé. */
  setGroup(groupId: string): boolean {
    if (groupId === this.groupId) return false;
    this.groupId = groupId;
    this.reset();
    return true;
  }

  /** Démontage : minuterie arrêtée, réponses en attente ignorées. */
  dispose(): void {
    this.reset();
  }

  private reset(): void {
    this.reqId++;
    this.inflight = false;
    this.state = DIRECT;
    this.tree = undefined;
    this.syncTimer();
  }

  private dispatch(a: ReplayAction): void {
    const prev = this.state;
    const next = replayReducer(prev, a);
    if (next === prev) return;
    this.state = next;
    if (next.instant !== prev.instant) this.request();
    this.syncTimer();
    this.deps.onChange();
  }

  private request(): void {
    const id = ++this.reqId;
    const ts = this.state.instant;
    if (ts === null) {
      this.inflight = false;
      this.tree = undefined;
      return;
    }
    this.inflight = true;
    // L'arbre précédent reste affiché pendant la requête (le bandeau affiche l'instant de l'arbre à l'écran).
    this.deps.fetch(this.groupId, Math.round(ts)).then(
      (t) => this.settle(id, t),
      () => this.settle(id, null),
    );
  }

  private settle(id: number, t: ProcTreeAt | null): void {
    if (id !== this.reqId) return;
    this.inflight = false;
    this.tree = t;
    this.deps.onChange();
  }

  private syncTimer(): void {
    if (this.state.playing && !this.timer) {
      this.timer = setInterval(() => {
        if (this.deps.isLive() && !this.inflight) this.dispatch({ type: 'tick', elapsedMs: REPLAY_TICK_MS });
      }, REPLAY_TICK_MS);
    } else if (!this.state.playing && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
