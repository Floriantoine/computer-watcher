// Anti-gel : freinage récent d'un cgroup (pur). « Freiné » = le noyau a compté un dépassement de memory.high (compteur
// « high » de memory.events) dans la dernière minute ; la part est le temps passé à attendre la mémoire (PSI « some » de
// memory.pressure : µs cumulées où au moins une tâche du cgroup est bloquée sur la mémoire), mesure en temps exacte
// entre deux ticks. Sans memory.pressure : part des intervalles entre ticks où le compteur « high » a augmenté.
export const RECENT_MS = 60_000;
/** Taille bornée de la fenêtre (passes rapprochées comprises) : un échantillon par seconde au plus en pratique. */
const MAX_SAMPLES = RECENT_MS / 1000 + 2;

export interface RecentSample { at: number; high: number; stallUs: number | null }

export interface Recent {
  push(s: RecentSample): void;
  /** Part (0–100, entière) de la dernière minute passée freinée ; undefined si aucun dépassement dans la fenêtre. */
  pct(): number | undefined;
  size(): number;
}

export function createRecent(): Recent {
  let s: RecentSample[] = [];
  return {
    push(x) {
      const last = s.at(-1);
      // horloge qui recule ou compteur remis à zéro (cgroup recréé) : fenêtre repartie de cet échantillon
      if (last && (x.at < last.at || x.high < last.high)) s = [];
      s.push(x);
      // échantillons de la fenêtre, plus un ancrage juste avant elle
      const cut = x.at - RECENT_MS;
      while (s.length > 2 && s[1]!.at <= cut) s.shift();
      if (s.length > MAX_SAMPLES) s.splice(1, s.length - MAX_SAMPLES);
    },
    pct() {
      if (s.length < 2) return undefined;
      let grew = false;
      let grewMs = 0;
      for (let k = 1; k < s.length; k++) {
        if (s[k]!.high > s[k - 1]!.high) {
          grew = true;
          grewMs += s[k]!.at - s[k - 1]!.at;
        }
      }
      if (!grew) return undefined;
      const last = s.at(-1)!;
      const span = last.at - s[0]!.at;
      if (span <= 0) return undefined;
      // PSI depuis le premier échantillon qui l'a (memory.pressure apparu en cours de fenêtre)
      const from = s.find((x) => x.stallUs !== null);
      const psi = from !== undefined && from !== last && last.stallUs !== null && last.stallUs >= from.stallUs!;
      const ratio = psi ? (last.stallUs! - from.stallUs!) / 1000 / (last.at - from.at) : grewMs / span;
      return Math.max(0, Math.min(100, Math.round(100 * ratio)));
    },
    size: () => s.length,
  };
}
