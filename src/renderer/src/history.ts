import { useEffect, useRef, useState } from 'react';
import type { ProcsHistory, SystemInfo } from '../../core/types';

export interface SystemPoint { ts: number; memUsedKB: number; swapUsedKB: number; psi: number | null; load: number }

export class LiveBuffer {
  private sys: SystemPoint[] = [];
  private groups = new Map<string, { ts: number; v: number }[]>();
  constructor(private keepMs = 30 * 60_000) {}

  push(ts: number, s: SystemInfo, groups: { id: string; rssKB: number; swapKB: number }[]): void {
    this.sys.push({ ts, memUsedKB: s.memTotalKB - s.memAvailableKB, swapUsedKB: s.swapTotalKB - s.swapFreeKB, psi: s.psiSome10, load: s.load1 });
    for (const g of groups) {
      const arr = this.groups.get(g.id) ?? [];
      arr.push({ ts, v: g.rssKB + g.swapKB });
      this.groups.set(g.id, arr);
    }
    const cut = ts - this.keepMs;
    this.sys = this.sys.filter((p) => p.ts >= cut);
    for (const [k, arr] of this.groups) {
      const kept = arr.filter((p) => p.ts >= cut);
      if (kept.length) this.groups.set(k, kept);
      else this.groups.delete(k);
    }
  }
  system(): SystemPoint[] {
    return this.sys;
  }
  group(key: string): number[] {
    return (this.groups.get(key) ?? []).map((p) => p.v);
  }
}

let live = true;
const liveListeners = new Set<() => void>();
/** Collecte en direct active (false : fenêtre réduite ou cachée, les rafraîchissements périodiques sont suspendus). */
export function setLive(v: boolean): void {
  const resumed = v && !live;
  live = v;
  if (resumed) for (const f of liveListeners) f();
}
/** Collecte en direct active (lecture sans abonnement, pour les minuteries hors React). */
export const isLive = (): boolean => live;
/** `cb` à chaque reprise de la collecte en direct ; renvoie la désinscription. */
export function onLiveResume(cb: () => void): () => void {
  liveListeners.add(cb);
  return () => {
    liveListeners.delete(cb);
  };
}

/**
 * Charge des données d'historique et les rafraîchit périodiquement (`refreshMs` nul : jamais) ; ignore les réponses obsolètes.
 * Pas de rafraîchissement périodique tant que la fenêtre est réduite ou cachée.
 */
export function useHistory<T>(fetch: () => Promise<T>, deps: unknown[], refreshMs: number | null = 30_000): T | undefined {
  const [data, setData] = useState<T>();
  const gen = useRef(0);
  useEffect(() => {
    const id = ++gen.current;
    const load = () =>
      fetch().then(
        (d) => {
          if (gen.current === id) setData(d);
        },
        () => {},
      );
    void load();
    if (refreshMs === null) return;
    const t = setInterval(() => {
      if (live) void load();
    }, refreshMs);
    // Reprise (fenêtre restaurée) : données fraîches tout de suite, sans attendre le prochain intervalle.
    const off = onLiveResume(() => void load());
    return () => {
      clearInterval(t);
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return data;
}

/** Séries mémoire des processus enregistrés, indexées par `${pid}:${startTicks}`. */
export function procSparkMap(h: ProcsHistory | null | undefined): Map<string, (number | null)[]> {
  return new Map((h?.series ?? []).map((s) => [`${s.pid}:${s.startTicks}`, s.memKB]));
}
