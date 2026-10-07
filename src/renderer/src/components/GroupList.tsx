import { memo, useLayoutEffect, useRef, useState, type MouseEvent, type Ref } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { ChevronDown, ChevronUp, Lock } from 'lucide-react';
import type { GroupSummary as Group } from '../../../core/types';
import { formatAge, formatCpu, formatKB } from '../format';
import { sortForList, type ListColumn } from '../listSort';
import { rowDisplayEqual, sameSeries } from '../renderEquality';
import type { GroupActions } from './GroupCard';
import { Sparkline } from './charts/Sparkline';
import { AnimatedNumber, ForceButton, GroupIcon, KillButton, LeakBadge } from './ui';

const DAY = 86400;

interface Props {
  groups: Group[];
  sparkOf: (groupId: string) => (number | null)[];
  stuckPids: Set<number>;
  pendingPids: Set<number>;
  actions: GroupActions;
  leakAt?: Map<string, number>;
}

const COLUMNS: { col: ListColumn; label: string; num: boolean }[] = [
  { col: 'name', label: 'Groupe', num: false },
  { col: 'procs', label: 'Proc.', num: true },
  { col: 'mem', label: 'RAM', num: true },
  { col: 'swap', label: 'Swap', num: true },
  { col: 'cpu', label: 'CPU', num: true },
  { col: 'age', label: 'Âge', num: true },
];

interface RowProps {
  group: Group;
  spark: (number | null)[];
  stuck: boolean;
  pending: boolean;
  leak?: boolean;
  layoutKey: string;
  actions: GroupActions;
  ref?: Ref<HTMLTableRowElement>;
}

function GroupRowImpl({ group, spark, stuck, pending, leak, layoutKey, actions, ref }: RowProps) {
  const isPresent = useIsPresent();
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    if (isPresent) fn();
  };
  return (
    <motion.tr
      ref={ref}
      data-testid="group-row"
      onClick={() => {
        if (isPresent) actions.open(group.id);
      }}
      layout="position"
      layoutDependency={layoutKey}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.15, ease: 'easeIn' } }}
      transition={{ duration: 0.2, layout: { duration: 0.32, ease: [0.22, 1, 0.36, 1] } }}
      style={{ pointerEvents: isPresent ? undefined : 'none' }}
    >
      <td className="name">
        <span className="name-cell">
          <GroupIcon id={group.id} kind={group.kind} size="sm" />
          <span className="label">{group.label}</span>
          {group.protected && (
            <span className="lock" title="Contient des processus protégés" aria-label="Contient des processus protégés" role="img">
              <Lock size={12} strokeWidth={2.4} />
            </span>
          )}
          {leak && <LeakBadge onClick={stop(() => actions.leak(group.id))} />}
        </span>
      </td>
      <td className="num">{group.procCount}</td>
      <td className="spark-cell"><Sparkline values={spark} tone="mem" height={22} /></td>
      <td className="num"><AnimatedNumber value={group.rssKB + group.swapKB} /></td>
      <td className="num">{formatKB(group.swapKB)}</td>
      <td className="num">{formatCpu(group.cpuPercent)}</td>
      <td className={`num ${group.oldestAgeSec > DAY ? 'old' : ''}`}>{formatAge(group.oldestAgeSec)}</td>
      <td className="act">
        {group.kind !== 'others' &&
          (stuck ? (
            <ForceButton onClick={stop(() => actions.force(group.id))} />
          ) : (
            <KillButton size="sm" pending={pending} disabled={!group.killable} onClick={stop(() => actions.kill(group.id))} />
          ))}
      </td>
    </motion.tr>
  );
}

const GroupRow = memo(
  GroupRowImpl,
  (a, b) =>
    a.actions === b.actions &&
    a.ref === b.ref &&
    a.layoutKey === b.layoutKey &&
    a.stuck === b.stuck &&
    a.pending === b.pending &&
    a.leak === b.leak &&
    sameSeries(a.spark, b.spark) &&
    rowDisplayEqual(a.group, b.group),
);

export function GroupList({ groups, sparkOf, stuckPids, pendingPids, actions, leakAt }: Props) {
  const [sort, setSort] = useState<{ col: ListColumn; dir: 'asc' | 'desc' }>({ col: 'mem', dir: 'desc' });
  const order = useRef<{ key: string; ids: string[] }>({ key: '', ids: [] });
  const sortKey = `${sort.col}:${sort.dir}`;
  const rows = sortForList(groups, sort.col, sort.dir, order.current.key === sortKey ? order.current.ids : []);
  useLayoutEffect(() => {
    order.current = { key: sortKey, ids: rows.map((g) => g.id) };
  });
  const layoutKey = rows.map((g) => g.id).join('\n');
  const toggle = (col: ListColumn) =>
    setSort((s) => (s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: col === 'name' ? 'asc' : 'desc' }));
  return (
    <div className="panel list-panel">
      <table className="group-list">
        <thead>
          <tr>
            {COLUMNS.flatMap(({ col, label, num }) => {
              const active = sort.col === col;
              const Chevron = sort.dir === 'asc' ? ChevronUp : ChevronDown;
              const th = (
                <th
                  key={col}
                  className={num ? 'num' : ''}
                  aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  <button type="button" className="th-btn" data-testid={`sort-${col}`} onClick={() => toggle(col)}>
                    {label}
                    {active && <Chevron size={12} strokeWidth={2.4} />}
                  </button>
                </th>
              );
              return col === 'procs' ? [th, <th key="spark" aria-hidden />] : [th];
            })}
            <th aria-hidden />
          </tr>
        </thead>
        <tbody>
          <AnimatePresence mode="popLayout" initial={false}>
            {rows.map((g) => (
              <GroupRow
                key={g.id}
                group={g}
                spark={sparkOf(g.id)}
                stuck={g.pids.some((pid) => stuckPids.has(pid))}
                pending={g.pids.some((pid) => pendingPids.has(pid))}
                leak={leakAt?.has(g.id)}
                layoutKey={layoutKey}
                actions={actions}
              />
            ))}
          </AnimatePresence>
        </tbody>
      </table>
    </div>
  );
}
