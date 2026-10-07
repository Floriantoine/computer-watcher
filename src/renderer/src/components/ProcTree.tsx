import { useMemo, useState, type ReactElement } from 'react';
import type { ProcNode } from '../../../core/types';
import { ChevronRight, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { formatAge, formatCpu, formatKB } from '../format';
import { Sparkline } from './charts/Sparkline';
import { allExpandableKeys, branchTotals, nodeKey } from '../tree';
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
  /** Mémoire de la dernière heure d'un processus enregistré, si le service l'a suivi. */
  sparkOf?: (pid: number, startTicks: number) => (number | null)[] | undefined;
  onKill: (node: ProcNode) => void;
  onForce: (pid: number) => void;
}

export function ProcTree({ roots, stuckPids, pendingPids, currentUid, sparkOf, onKill, onForce }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    count(roots) > COLLAPSE_ABOVE ? new Set() : new Set(allExpandableKeys(roots)),
  );
  const toggle = (key: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const totals = useMemo(() => branchTotals(roots), [roots]);
  const sortedRoots = useMemo(
    () => [...roots].sort((a, b) => (totals.get(nodeKey(b))?.memKB ?? 0) - (totals.get(nodeKey(a))?.memKB ?? 0)),
    [roots, totals],
  );
  const expandable = useMemo(() => allExpandableKeys(roots), [roots]);
  const allOpen = expandable.length > 0 && expandable.every((k) => expanded.has(k));
  const toggleAll = () => setExpanded(allOpen ? new Set() : new Set(expandable));

  const rows: ReactElement[] = [];
  const walk = (nodes: ProcNode[], depth: number) => {
    for (const n of nodes) {
      const p = n.proc;
      const key = nodeKey(n);
      const open = expanded.has(key);
      const total = n.children.length ? totals.get(key) : undefined;
      rows.push(
        <tr key={key}>
          <td className="pid mono" style={{ paddingLeft: 6 + depth * 18 }}>
            <span className="pid-cell">
              {n.children.length ? (
                <button className={`toggle ${open ? 'open' : ''}`} aria-label={open ? 'Replier' : 'Déplier'} aria-expanded={open} onClick={() => toggle(key)}>
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
          <td className="spark-cell">{spark(sparkOf?.(p.pid, p.startTicks))}</td>
          <td className="num mono">{formatCpu(p.cpuPercent)}</td>
          <td className="num mono">
            {formatKB(p.rssKB)}
            {total && <small className="branch-total" data-testid="branch-total" title="RAM + swap de la branche (ce processus et ses descendants)">Σ {formatKB(total.memKB)} · {total.count} proc</small>}
          </td>
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
  walk(sortedRoots, 0);

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Processus</h3>
        <span className="spacer" />
        {expandable.length > 0 && (
          <button className="tree-toggle-all" data-testid="toggle-all" onClick={toggleAll}>
            {allOpen ? <ChevronsDownUp size={14} strokeWidth={2} /> : <ChevronsUpDown size={14} strokeWidth={2} />}
            {allOpen ? 'Tout replier' : 'Tout déplier'}
          </button>
        )}
      </div>
      <div className="panel-scroll">
        <table className="tree">
          <thead>
            <tr><th>PID</th><th>Commande</th><th>Dossier</th><th className="spark-cell">1 h</th><th className="num">CPU</th><th className="num">RAM</th><th className="num">Swap</th><th className="num">Depuis</th><th /></tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
      </div>
    </div>
  );
}

function spark(values: (number | null)[] | undefined) {
  return values && values.filter((v) => v !== null).length >= 2 ? <Sparkline values={values} tone="mem" height={18} /> : <span className="mono">—</span>;
}
