// Dernière analyse « projets, ~/.cache, Docker » de la page Disque, gardée un moment. Un compteur de génération écarte
// l'analyse lancée avant un ménage : elle ne réécrit pas l'état (éléments peut-être supprimés) et l'appel suivant relance.
export interface ExtrasCache<V, S> {
  /** Vue récente, sinon analyse (partagée entre appels simultanés de la même génération). */
  get(force: boolean): Promise<V>;
  /** État de la dernière analyse gardée, ou null. */
  state(): S | null;
  /** Après un ménage : oublie l'analyse gardée et celle en cours. */
  invalidate(): void;
}

export function createExtrasCache<V extends { at: number }, S>(
  load: () => Promise<{ view: V; state: S }>,
  o: { maxAgeMs: number; now: () => number },
): ExtrasCache<V, S> {
  let current: { view: V; state: S } | null = null;
  let running: Promise<V> | null = null;
  let gen = 0;
  return {
    get(force) {
      const age = current ? o.now() - current.view.at : Infinity;
      if (!force && current && age >= 0 && age < o.maxAgeMs) return Promise.resolve(current.view);
      if (running) return running;
      const g = gen;
      let p: Promise<V> | null = null;
      p = (async () => {
        try {
          const r = await load();
          if (g === gen) current = r;
          return r.view;
        } finally {
          if (running === p) running = null;
        }
      })();
      running = p;
      return p;
    },
    state: () => current?.state ?? null,
    invalidate() {
      gen++;
      current = null;
      running = null;
    },
  };
}
