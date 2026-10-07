import { useState, type ReactElement } from 'react';
import type { ProcNode } from '../../../core/types';
import { ChevronRight } from 'lucide-react';
import { formatAge, formatCpu, formatKB } from '../format';
import { ForceButton, KillButton } from './ui';

const DAY = 86400;
const COLLAPSE_ABOVE = 20;

function count(nodes: ProcNode[]): number {
  return nodes.reduce((s, n) => s + 1 + count(n.children), 0);
}

interface Props {
  roots: ProcNode[];
  stuckPids: Set<number>;
  pendingPids: Set<number>;
  currentUid: number;
  onKill: (node: ProcNode) => void;
  onForce: (pid: number) => void;
}

export function ProcTree({ roots, stuckPids, pendingPids, currentUid, onKill, onForce }: Props) {
  const [expanded, setExpanded] = useState<Set<number>>(() =>
    count(roots) > COLLAPSE_ABOVE ? new Set() : new Set(collectPids(roots)),
  );
  const toggle = (pid: number) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });

  const rows: ReactElement[] = [];
  const walk = (nodes: ProcNode[], depth: number) => {
    for (const n of nodes) {
      const p = n.proc;
      const open = expanded.has(p.pid);
      rows.push(
        <tr key={p.pid}>
          <td className="pid mono" style={{ paddingLeft: 6 + depth * 18 }}>
            <span className="pid-cell">
              {n.children.length ? (
                <button className={`toggle ${open ? 'open' : ''}`} aria-label={open ? 'Replier' : 'Déplier'} aria-expanded={open} onClick={() => toggle(p.pid)}>
                  <ChevronRight size={13} strokeWidth={2.2} />
                </button>
              ) : (
                <span className="toggle-spacer" />
              )}
              {p.pid}
            </span>
          </td>
          <td className="cmd mono" title={p.cmdline}>{p.cmdline}</td>
          <td className="cwd mono" title={p.cwd ?? ''}>{p.cwdDeleted ? '(supprimé) ' : ''}{p.cwd ?? '—'}</td>
          <td className="num mono">{formatCpu(p.cpuPercent)}</td>
          <td className="num mono">{formatKB(p.rssKB)}</td>
          <td className="num mono">{formatKB(p.swapKB)}</td>
          <td className={`num mono ${p.ageSec > DAY ? 'old' : ''}`}>{formatAge(p.ageSec)}</td>
          <td className="act">
            {stuckPids.has(p.pid) ? (
              <ForceButton onClick={() => onForce(p.pid)} />
            ) : (
              <KillButton size="sm" pending={pendingPids.has(p.pid)} disabled={p.uid !== currentUid} onClick={() => onKill(n)} />
            )}
          </td>
        </tr>,
      );
      if (open) walk(n.children, depth + 1);
    }
  };
  walk(roots, 0);

  return (
    <div className="panel">
      <div className="panel-scroll">
        <table className="tree">
          <thead>
            <tr><th>PID</th><th>Commande</th><th>Dossier</th><th className="num">CPU</th><th className="num">RAM</th><th className="num">Swap</th><th className="num">Depuis</th><th /></tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
      </div>
    </div>
  );
}

function collectPids(nodes: ProcNode[], out: number[] = []): number[] {
  for (const n of nodes) {
    out.push(n.proc.pid);
    collectPids(n.children, out);
  }
  return out;
}
