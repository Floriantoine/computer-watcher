import { memo, useCallback, useMemo, useRef, useState, type ReactElement } from 'react';
import type { ProcNode } from '../../../core/types';
import { ChevronRight, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { formatAge, formatCpu, formatKB } from '../format';
import { Sparkline } from './charts/Sparkline';
import { procRowDisplayEqual, sameSeries } from '../renderEquality';
import { allExpandableKeys, branchTotals, nodeKey, type BranchTotal } from '../tree';
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

interface RowActions {
  toggle: (key: string) => void;
  kill: (node: ProcNode) => void;
  force: (pid: number) => void;
}

interface RowProps {
  node: ProcNode;
  depth: number;
  open: boolean;
  total: BranchTotal | undefined;
  spark: (number | null)[] | undefined;
  stuck: boolean;
  pending: boolean;
  canKill: boolean;
  actions: RowActions;
}

function ProcRowImpl({ node: n, depth, open, total, spark: values, stuck, pending, canKill, actions }: RowProps) {
  const p = n.proc;
  const key = nodeKey(n);
  return (
    <tr>
      <td className="pid mono" style={{ paddingLeft: 6 + depth * 18 }}>
        <span className="pid-cell">
          {n.children.length ? (
            <button className={`toggle ${open ? 'open' : ''}`} aria-label={open ? 'Replier' : 'Déplier'} aria-expanded={open} onClick={() => actions.toggle(key)}>
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
      <td className="spark-cell">{spark(values)}</td>
      <td className="num mono">{formatCpu(p.cpuPercent)}</td>
      <td className="num mono">
        {formatKB(p.rssKB)}
        {total && <small className="branch-total" data-testid="branch-total" title="RAM + swap de la branche (ce processus et ses descendants)">Σ {formatKB(total.memKB)} · {total.count} proc</small>}
      </td>
      <td className="num mono">{formatKB(p.swapKB)}</td>
      <td className={`num mono ${p.ageSec > DAY ? 'old' : ''}`}>{formatAge(p.ageSec)}</td>
      <td className="act">
        {stuck ? (
          <ForceButton onClick={() => actions.force(p.pid)} />
        ) : (
          <KillButton size="sm" pending={pending} disabled={!canKill} onClick={() => actions.kill(n)} />
        )}
      </td>
    </tr>
  );
}

const sameTotal = (a: BranchTotal | undefined, b: BranchTotal | undefined) =>
  a === b || (!!a && !!b && a.count === b.count && formatKB(a.memKB) === formatKB(b.memKB));

/** Une ligne ne se re-rend que si ce qu'elle affiche change. */
const ProcRow = memo(
  ProcRowImpl,
  (a, b) =>
    a.actions === b.actions &&
    a.depth === b.depth &&
    a.open === b.open &&
    a.stuck === b.stuck &&
    a.pending === b.pending &&
    a.canKill === b.canKill &&
    (a.node.children.length > 0) === (b.node.children.length > 0) &&
    sameTotal(a.total, b.total) &&
    sameSeries(a.spark, b.spark) &&
    procRowDisplayEqual(a.node.proc, b.node.proc),
);

export function ProcTree({ roots, stuckPids, pendingPids, currentUid, sparkOf, onKill, onForce }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    count(roots) > COLLAPSE_ABOVE ? new Set() : new Set(allExpandableKeys(roots)),
  );
  const toggle = useCallback(
    (key: string) =>
      setExpanded((s) => {
        const next = new Set(s);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    [],
  );
  const latest = useRef({ onKill, onForce });
  latest.current = { onKill, onForce };
  const actions = useMemo<RowActions>(
    () => ({ toggle, kill: (n) => latest.current.onKill(n), force: (pid) => latest.current.onForce(pid) }),
    [toggle],
  );
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
      const key = nodeKey(n);
      const open = expanded.has(key);
      rows.push(
        <ProcRow
          key={key}
          node={n}
          depth={depth}
          open={open}
          total={n.children.length ? totals.get(key) : undefined}
          spark={sparkOf?.(n.proc.pid, n.proc.startTicks)}
          stuck={stuckPids.has(n.proc.pid)}
          pending={pendingPids.has(n.proc.pid)}
          canKill={n.proc.uid === currentUid}
          actions={actions}
        />,
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
