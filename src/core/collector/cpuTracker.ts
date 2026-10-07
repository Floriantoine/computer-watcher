import type { ProcInfo, ProcSample } from '../types';
import { CLK_TCK } from './readProcesses';

export class CpuTracker {
  private prev = new Map<number, { startTicks: number; cpuTicks: number }>();
  private prevAt: number | null = null;

  update(samples: ProcSample[], nowMs: number): ProcInfo[] {
    const dtSec = this.prevAt === null ? 0 : (nowMs - this.prevAt) / 1000;
    const next = new Map<number, { startTicks: number; cpuTicks: number }>();
    const result = samples.map((s) => {
      const p = this.prev.get(s.pid);
      let cpuPercent = 0;
      if (p && p.startTicks === s.startTicks && dtSec > 0) {
        cpuPercent = Math.max(0, ((s.cpuTicks - p.cpuTicks) / CLK_TCK / dtSec) * 100);
      }
      next.set(s.pid, { startTicks: s.startTicks, cpuTicks: s.cpuTicks });
      return { ...s, cpuPercent };
    });
    this.prev = next;
    this.prevAt = nowMs;
    return result;
  }
}
