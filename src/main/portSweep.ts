import { dedupeSockets, type ListenSocket } from '../core/collector/ports';

/** Ports de tous les processus de l'utilisateur (pid → ports) et sockets en écoute dédoublonnés. */
export interface Listen {
  byPid: ReadonlyMap<number, number[]>;
  sockets: readonly ListenSocket[];
  /** Processus à trop de fd pour une tranche, non lus */
  tooBig: number;
}

export interface PortSweepDeps {
  /** Sockets en écoute bruts (/proc/net/tcp{,6}) */
  readSockets(): ListenSocket[];
  readSlice(pids: readonly number[], start: number, sockets: readonly ListenSocket[], maxFds: number): { ports: Map<number, number[]>; next: number; tooBig: number[] };
  /** Pids de l'utilisateur à lire, périmètre du classement en tête */
  pids(): number[];
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  now(): number;
  /** Passe terminée : `listen` est à jour */
  onDone(listen: Listen): void;
}

export interface PortSweepOptions {
  /** Intervalle entre deux passes */
  everyMs: number;
  /** fd parcourus au plus par tranche (~3 µs par fd, plus la lecture de /proc/net en première tranche : ≤ ~10 ms de main bloqué) */
  maxFds: number;
  /** Pause entre deux tranches (le main traite l'IPC et le rendu entre elles) */
  gapMs: number;
}

/**
 * Lecture des ports de tous les processus de l'utilisateur (panneau « Ports ouverts » ou recherche `:port`), découpée en tranches
 * planifiées : jamais plus de `maxFds` fd lus d'affilée sur le main, jamais de lecture synchrone à l'entrée dans le mode.
 */
export class PortSweep {
  listen: Listen | undefined;
  private all = false;
  private timer: unknown = null;
  private running: { pids: number[]; i: number; acc: Map<number, number[]>; sockets: ListenSocket[]; tooBig: number } | null = null;
  private doneAt = -Infinity;

  constructor(
    private readonly deps: PortSweepDeps,
    private readonly opts: PortSweepOptions = { everyMs: 10_000, maxFds: 1500, gapMs: 20 },
  ) {}

  /** Entrée : passe planifiée tout de suite (tranche suivante de la boucle d'événements). Sortie : passe annulée, liste effacée. */
  setMode(all: boolean): void {
    if (all === this.all) return;
    this.all = all;
    if (all) {
      this.plan(0);
      return;
    }
    if (this.timer !== null) this.deps.cancel(this.timer);
    this.timer = null;
    this.running = null;
    this.listen = undefined;
    this.doneAt = -Infinity;
  }

  /** À chaque tick de collecte : nouvelle passe si la précédente date de `everyMs` ou plus. */
  tick(): void {
    if (!this.all || this.running || this.timer !== null) return;
    if (this.deps.now() - this.doneAt >= this.opts.everyMs) this.plan(0);
  }

  private plan(ms: number): void {
    if (this.timer !== null) return;
    this.timer = this.deps.schedule(() => {
      this.timer = null;
      this.step();
    }, ms);
  }

  private step(): void {
    if (!this.all) return;
    this.running ??= { pids: this.deps.pids(), i: 0, acc: new Map(), sockets: this.deps.readSockets(), tooBig: 0 };
    const r = this.running;
    const slice = this.deps.readSlice(r.pids, r.i, r.sockets, this.opts.maxFds);
    for (const [pid, ports] of slice.ports) r.acc.set(pid, ports);
    r.tooBig += slice.tooBig.length;
    r.i = slice.next;
    if (r.i < r.pids.length) {
      this.plan(this.opts.gapMs);
      return;
    }
    this.running = null;
    this.doneAt = this.deps.now();
    this.listen = { byPid: r.acc, sockets: dedupeSockets(r.sockets), tooBig: r.tooBig };
    this.deps.onDone(this.listen);
  }
}
