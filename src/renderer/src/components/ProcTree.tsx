import { useState, type ReactElement } from 'react';
import type { ProcNode } from '../../../core/types';
import { formatAge, formatCpu, formatKB } from '../format';

const DAY = 86400;
const COLLAPSE_ABOVE = 20;

function count(nodes: ProcNode[]): number {
  return nodes.reduce((s, n) => s + 1 + count(n.children), 0);
}

interface Props {
  roots: ProcNode[];
  stuckPids: Set<number>;
  currentUid: number;
  onKill: (node: ProcNode) => void;
  onForce: (pid: number) => void;
}

export function ProcTree({ roots, stuckPids, currentUid, onKill, onForce }: Props) {
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
          <td style={{ paddingLeft: 8 + depth * 18 }}>
            <span className="toggle" onClick={() => toggle(p.pid)}>{n.children.length ? (open ? '▾' : '▸') : ''}</span>
            {p.pid}
          </td>
          <td className="cmd mono" title={p.cmdline}>{p.cmdline}</td>
          <td className="mono" title={p.cwd ?? ''}>{p.cwdDeleted ? '(supprimé) ' : ''}{p.cwd ?? '—'}</td>
          <td>{formatCpu(p.cpuPercent)}</td>
          <td>{formatKB(p.rssKB)}</td>
          <td>{formatKB(p.swapKB)}</td>
          <td className={p.ageSec > DAY ? 'old' : ''}>{formatAge(p.ageSec)}</td>
          <td>
            {stuckPids.has(p.pid) ? (
              <button className="danger" onClick={() => onForce(p.pid)}>Forcer (SIGKILL)</button>
            ) : (
              <button className="danger" disabled={p.uid !== currentUid} onClick={() => onKill(n)}>Kill</button>
            )}
          </td>
        </tr>,
      );
      if (open) walk(n.children, depth + 1);
    }
  };
  walk(roots, 0);

  return (
    <table className="tree">
      <thead>
        <tr><th>PID</th><th>Commande</th><th>Dossier</th><th>CPU</th><th>RAM</th><th>Swap</th><th>Depuis</th><th /></tr>
      </thead>
      <tbody>{rows}</tbody>
    </table>
  );
}

function collectPids(nodes: ProcNode[], out: number[] = []): number[] {
  for (const n of nodes) {
    out.push(n.proc.pid);
    collectPids(n.children, out);
  }
  return out;
}
