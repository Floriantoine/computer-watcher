import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Group, ProcInfo, SystemInfo } from '../types';

export interface TickInput {
  ts: number;
  system: SystemInfo;
  /** CPU global en % de la machine entière */
  cpuPercent: number;
  groups: Group[];
  procs: ProcInfo[];
}

export interface WriteThresholds { procMinMemMB: number; procMinCpuPercent: number; groupMinMemMB: number }

/** Groupe synthétique qui cumule, à chaque tick, les groupes sous les seuils (évite ~300 groupes/tick en base). */
export const SMALL_GROUPS_KEY = 'others:small';
const SMALL_GROUPS = { id: SMALL_GROUPS_KEY, label: 'Petits groupes', kind: 'others' as const };

export class HistoryWriter {
  private procIds = new Map<string, { id: number; ppid: number }>();
  private s: Record<'system' | 'group' | 'groupSample' | 'proc' | 'procPpid' | 'procSample', StatementSync>;

  constructor(private db: DatabaseSync) {
    this.s = {
      system: db.prepare(
        'INSERT OR REPLACE INTO system_samples(ts, mem_used_kb, mem_total_kb, swap_used_kb, swap_total_kb, psi_some10, load1, cpu_percent) VALUES (?,?,?,?,?,?,?,?)',
      ),
      group: db.prepare(
        'INSERT INTO groups(key,label,kind) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET label=excluded.label, kind=excluded.kind RETURNING id',
      ),
      groupSample: db.prepare('INSERT OR REPLACE INTO group_samples VALUES (?,?,?,?,?,?)'),
      proc: db.prepare(
        'INSERT INTO procs(pid,start_ticks,name,cmdline,group_id,ppid) VALUES (?,?,?,?,?,?) ON CONFLICT(pid,start_ticks) DO UPDATE SET group_id=excluded.group_id, ppid=excluded.ppid RETURNING id',
      ),
      procPpid: db.prepare('UPDATE procs SET ppid = ? WHERE id = ?'),
      procSample: db.prepare('INSERT OR REPLACE INTO proc_samples VALUES (?,?,?,?,?)'),
    };
  }

  /** Vide le cache d'ids de processus (à appeler après une purge). */
  forget(): void {
    this.procIds.clear();
  }

  /** Upsert à chaque tick : garde le libellé à jour et renvoie l'id stable. */
  private groupId(g: { id: string; label: string; kind: string }): number {
    return (this.s.group.get(g.id, g.label, g.kind) as { id: number }).id;
  }

  writeTick(t: TickInput, thresholds: WriteThresholds): { groups: number; procs: number } {
    const minKB = thresholds.procMinMemMB * 1024;
    const groupMinKB = thresholds.groupMinMemMB * 1024;
    const groupOfPid = new Map<number, number>();
    let procCount = 0;
    let groupCount = 0;
    this.db.exec('BEGIN');
    try {
      const s = t.system;
      this.s.system.run(t.ts, s.memTotalKB - s.memAvailableKB, s.memTotalKB, s.swapTotalKB - s.swapFreeKB, s.swapTotalKB, s.psiSome10, s.load1, t.cpuPercent);
      const small = { groups: 0, rssKB: 0, swapKB: 0, cpuPercent: 0, procCount: 0, pids: [] as number[] };
      for (const g of t.groups) {
        if (g.rssKB + g.swapKB < groupMinKB && g.cpuPercent < thresholds.procMinCpuPercent) {
          small.groups++;
          small.rssKB += g.rssKB;
          small.swapKB += g.swapKB;
          small.cpuPercent += g.cpuPercent;
          small.procCount += g.procCount;
          small.pids.push(...g.pids);
          continue;
        }
        const id = this.groupId(g);
        for (const pid of g.pids) groupOfPid.set(pid, id);
        this.s.groupSample.run(t.ts, id, g.rssKB, g.swapKB, g.cpuPercent, g.procCount);
        groupCount++;
      }
      if (small.groups > 0) {
        const id = this.groupId(SMALL_GROUPS);
        for (const pid of small.pids) groupOfPid.set(pid, id);
        this.s.groupSample.run(t.ts, id, small.rssKB, small.swapKB, small.cpuPercent, small.procCount);
        groupCount++;
      }
      for (const p of t.procs) {
        if (p.rssKB + p.swapKB < minKB && p.cpuPercent < thresholds.procMinCpuPercent) continue;
        const gid = groupOfPid.get(p.pid);
        if (gid === undefined) continue;
        const key = `${p.pid}:${p.startTicks}`;
        let known = this.procIds.get(key);
        if (known === undefined) {
          const id = (this.s.proc.get(p.pid, p.startTicks, p.name, p.cmdline, gid, p.ppid) as { id: number }).id;
          known = { id, ppid: p.ppid };
          this.procIds.set(key, known);
        } else if (known.ppid !== p.ppid) {
          // reparentage (le parent est mort) : une seule UPDATE, pas de coût par tick
          this.s.procPpid.run(p.ppid, known.id);
          known.ppid = p.ppid;
        }
        this.s.procSample.run(t.ts, known.id, p.rssKB, p.swapKB, p.cpuPercent);
        procCount++;
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { groups: groupCount, procs: procCount };
  }
}
