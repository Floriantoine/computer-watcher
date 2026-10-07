import { useEffect, useRef, useState } from 'react';
import type { SystemInfo } from '../../core/types';

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

/** Charge des données d'historique et les rafraîchit périodiquement ; ignore les réponses obsolètes. */
export function useHistory<T>(fetch: () => Promise<T>, deps: unknown[], refreshMs = 30_000): T | undefined {
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
    const t = setInterval(load, refreshMs);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return data;
}
