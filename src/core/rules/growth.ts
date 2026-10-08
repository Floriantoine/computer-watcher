// src/core/rules/growth.ts — croissance mémoire par processus (pid + startTicks) sur 5 min, pour la condition (c) :
// la croissance d'une instance est la somme de celle de ses processus (attribution par instance, pas par groupe).
// Horloge monotone ; un trou (> 4 × intervalle) ou un recul d'horloge vide l'historique (rien n'est attribué tant que
// 5 min n'ont pas été observées d'affilée).

export const GROWTH_WINDOW_MS = 5 * 60_000;
/** Un instantané au plus toutes les 30 s (≈ 12 sur la fenêtre). */
const SNAPSHOT_EVERY_MS = 30_000;

type Proc = { pid: number; startTicks: number; rssKB: number; swapKB: number };

export class ProcGrowth {
  private snaps: { t: number; mem: Map<string, number> }[] = [];
  private latest: { t: number; mem: Map<string, number> } | null = null;
  constructor(private readonly intervalMs: number) {}

  push(t: number, procs: readonly Proc[]): void {
    const last = this.latest;
    if (last && (t < last.t || t - last.t > 4 * this.intervalMs)) this.snaps = [];
    const mem = new Map(procs.map((p) => [`${p.pid}:${p.startTicks}`, p.rssKB + p.swapKB]));
    this.latest = { t, mem };
    const prev = this.snaps[this.snaps.length - 1];
    if (!prev || t - prev.t >= SNAPSHOT_EVERY_MS) this.snaps.push({ t, mem });
    // garder l'instantané le plus récent qui a au moins 5 min (référence), et tout ce qui suit
    let i = 0;
    while (i + 1 < this.snaps.length && t - this.snaps[i + 1]!.t >= GROWTH_WINDOW_MS) i++;
    if (i) this.snaps.splice(0, i);
  }

  /** `${pid}:${startTicks}` → hausse sur 5 min (processus apparu depuis : toute sa mémoire) ; null sans 5 min observées. */
  growth(t: number): Map<string, number> | null {
    const cur = this.latest;
    const ref = this.snaps[0];
    if (!cur || cur.t !== t || !ref || t - ref.t < GROWTH_WINDOW_MS) return null;
    const out = new Map<string, number>();
    for (const [k, kb] of cur.mem) out.set(k, kb - (ref.mem.get(k) ?? 0));
    return out;
  }

  snapshots(): number {
    return this.snaps.length;
  }
}
