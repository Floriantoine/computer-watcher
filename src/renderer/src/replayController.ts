// src/renderer/src/replayController.ts — rejeu « voyage dans le temps » : état, minuterie et requêtes, hors de React (testé)
import type { GroupHistory, ProcTreeAt, TimeRange } from '../../core/types';
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
  /** Faux quand la fenêtre est réduite ou cachée : ni lecture ni requête jusqu'à la restauration. */
  isLive: () => boolean;
  /** Abonnement à la restauration de la fenêtre (la position en attente part alors) ; renvoie la désinscription. */
  onLiveResume?: (cb: () => void) => () => void;
  /** État ou arbre changé (hors setGroup, appelé pendant le rendu). */
  onChange: () => void;
}

export const REPLAY_TICK_MS = 1000;
/** Au plus une requête `history:procTree` par intervalle (survol continu du graphe). */
export const REPLAY_THROTTLE_MS = 100;
/** Arbres gardés par horodatage d'échantillon (LRU). */
export const REPLAY_CACHE_SIZE = 50;
/** Un arbre en cache plus vieux que ça est redemandé (les « mort à » des processus récents peuvent avoir changé). */
export const REPLAY_CACHE_TTL_MS = 60_000;

/**
 * Rejeu de l'arbre du détail.
 * - Survol du graphe (`hover`) : aperçu de l'instant pointé, sans rien figer ; `hover(null)` (souris sortie) revient
 *   à l'instant figé ou au direct, tout de suite.
 * - Clic (`pick`) : instant figé ; lecture ×60 (`play`) depuis cet instant, minuterie d'une seconde active seulement
 *   pendant la lecture. Pendant la lecture, le survol ne déplace pas l'instant joué.
 * - Requêtes : une à la fois, au plus une toutes les REPLAY_THROTTLE_MS ; la dernière position demandée gagne (les
 *   positions intermédiaires ne partent jamais). Cache LRU par horodatage. Réponse dépassée (retour au direct, instant
 *   servi par le cache, groupe changé) : mise en cache mais pas affichée. Rien ne part tant que la fenêtre est cachée.
 */
export class ReplayController {
  state: ReplayState = DIRECT;
  /** Instant survolé (aperçu), null hors du graphe. */
  preview: number | null = null;
  /** undefined = chargement (ou direct), null = pas de base. */
  tree: ProcTreeAt | null | undefined = undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private throttle: ReturnType<typeof setTimeout> | null = null;
  private inflight = false;
  /** Génération du groupe : une réponse d'un autre groupe est ignorée, même pour le cache. */
  private gen = 0;
  /** Dernière requête dont la réponse peut s'afficher. */
  private reqId = 0;
  /** Instant à demander dès que possible (dernière position gagnante). */
  private pending: number | null = null;
  /** Instant dont l'arbre est voulu (celui affiché ou attendu). */
  private wanted: number | null = null;
  private lastSent = -Infinity;
  private cache = new Map<number, { tree: ProcTreeAt; at: number }>();
  private offResume: (() => void) | null;

  constructor(private groupId: string, private deps: ReplayDeps) {
    this.offResume = deps.onLiveResume?.(() => this.pump()) ?? null;
  }

  /** Instant affiché : celui joué pendant la lecture, sinon le survol, sinon l'instant figé ; null = direct. */
  get shown(): number | null {
    return this.state.playing ? this.state.instant : this.preview ?? this.state.instant;
  }

  pick = (ts: number): void => this.dispatch({ type: 'pick', ts });
  play = (range: TimeRange): void => this.dispatch({ type: 'play', range });
  pause = (): void => this.dispatch({ type: 'pause' });
  /** Revient au direct (« Revenir au direct », Échap) : instant libéré et aperçu effacé. */
  live = (): void => {
    const had = this.preview !== null;
    this.preview = null;
    if (this.state === DIRECT) {
      if (had) this.update();
    } else this.dispatch({ type: 'live' });
  };
  /** Survol du graphe : instant pointé, ou null quand la souris en sort. */
  hover = (ts: number | null): void => {
    if (ts === this.preview) return;
    this.preview = ts;
    this.update();
  };

  /** Séries du graphe (tuiles à l'instant examiné, sans requête) ; nouvelle notification seulement hors du direct. */
  series: GroupHistory | null = null;
  setSeries = (h: GroupHistory | null): void => {
    if (h === this.series) return;
    this.series = h;
    if (this.shown !== null) this.deps.onChange();
  };

  /** Nouveau groupe : retour au direct immédiat, sans notification (appelé pendant le rendu). Vrai si le groupe a changé. */
  setGroup(groupId: string): boolean {
    if (groupId === this.groupId) return false;
    this.groupId = groupId;
    this.reset();
    return true;
  }

  /** Démontage : minuteries arrêtées, réponses en attente ignorées. */
  dispose(): void {
    this.reset();
    this.offResume?.();
    this.offResume = null;
  }

  private reset(): void {
    this.gen++;
    this.reqId++;
    this.inflight = false;
    this.pending = null;
    this.wanted = null;
    this.preview = null;
    this.series = null;
    this.cache.clear();
    this.state = DIRECT;
    this.tree = undefined;
    if (this.throttle) clearTimeout(this.throttle);
    this.throttle = null;
    this.syncTimer();
  }

  private dispatch(a: ReplayAction): void {
    const prev = this.state;
    const next = replayReducer(prev, a);
    if (next === prev) return;
    this.state = next;
    this.syncTimer();
    this.update();
  }

  /** Instant affiché changé (ou pas) : arbre depuis le cache, ou requête planifiée ; puis notification. */
  private update(): void {
    this.want(this.shown === null ? null : Math.round(this.shown));
    this.deps.onChange();
  }

  private want(ts: number | null): void {
    if (ts === this.wanted) return;
    this.wanted = ts;
    if (ts === null) {
      this.reqId++; // la requête en cours ne s'affichera pas
      this.pending = null;
      this.tree = undefined;
      return;
    }
    const hit = this.cache.get(ts);
    if (hit && Date.now() - hit.at <= REPLAY_CACHE_TTL_MS) {
      this.cache.delete(ts); // remis en tête (LRU)
      this.cache.set(ts, hit);
      this.reqId++;
      this.pending = null;
      this.tree = hit.tree;
      return;
    }
    // L'arbre précédent reste affiché pendant la requête (le bandeau affiche l'instant de l'arbre à l'écran).
    this.pending = ts;
    this.pump();
  }

  /** Envoie la position en attente si rien n'est en vol, si le délai minimal est passé et si la fenêtre est visible. */
  private pump(): void {
    if (this.pending === null || this.inflight || this.throttle || !this.deps.isLive()) return;
    const wait = this.lastSent + REPLAY_THROTTLE_MS - Date.now();
    if (wait > 0) {
      this.throttle = setTimeout(() => {
        this.throttle = null;
        this.pump();
      }, wait);
      return;
    }
    const ts = this.pending;
    this.pending = null;
    this.inflight = true;
    this.lastSent = Date.now();
    const id = ++this.reqId;
    const gen = this.gen;
    this.deps.fetch(this.groupId, ts).then(
      (t) => this.settle(gen, id, ts, t),
      () => this.settle(gen, id, ts, null),
    );
  }

  private settle(gen: number, id: number, ts: number, t: ProcTreeAt | null): void {
    if (gen !== this.gen) return;
    this.inflight = false;
    if (t) {
      this.cache.delete(ts);
      this.cache.set(ts, { tree: t, at: Date.now() });
      if (this.cache.size > REPLAY_CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
    }
    if (id === this.reqId) {
      this.tree = t;
      this.deps.onChange();
    }
    this.pump();
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
