import { memo, type MouseEvent, type Ref } from 'react';
import { motion, useIsPresent } from 'motion/react';
import { Lock } from 'lucide-react';
import type { GroupSummary as Group } from '../../../core/types';
import { formatAge, formatCpu } from '../format';
import { barWidth } from '../motionBudget';
import { cardDisplayEqual, sameSeries } from '../renderEquality';
import { cardTone } from '../theme';
import { Sparkline } from './charts/Sparkline';
import { AnimatedNumber, ForceButton, GroupIcon, KillButton, LeakBadge } from './ui';

const DAY = 86400;

/** Actions des cartes et lignes, par id de groupe : objet stable, pour que les cartes inchangées ne se re-rendent pas. */
export interface GroupActions {
  open: (id: string) => void;
  kill: (id: string) => void;
  force: (id: string) => void;
  leak: (id: string) => void;
}

interface Props {
  group: Group;
  memTotalKB: number;
  spark: (number | null)[];
  stuck: boolean;
  pending: boolean;
  leak?: boolean;
  /** Change seulement quand l'ordre des cartes change : seul cas où le layout s'anime. */
  layoutKey: string;
  actions: GroupActions;
  ref?: Ref<HTMLDivElement>;
}

function GroupCardImpl({ group, memTotalKB, spark, stuck, pending, leak, layoutKey, actions, ref }: Props) {
  const isPresent = useIsPresent();
  const total = group.rssKB + group.swapKB;
  const pct = Math.min(100, (total / memTotalKB) * 100);
  // Une carte en train de disparaître ne réagit plus aux clics.
  const guard = (fn: () => void) => () => {
    if (isPresent) fn();
  };
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    if (isPresent) fn();
  };
  const sub = [`${group.procCount} processus`, ...group.tags].join(' · ');
  return (
    <motion.div
      ref={ref}
      className="card"
      data-testid="group-card"
      onClick={guard(() => actions.open(group.id))}
      layout="position"
      layoutDependency={layoutKey}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.18, ease: 'easeIn' } }}
      whileHover={{ y: -2 }}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1], layout: { duration: 0.32, ease: [0.22, 1, 0.36, 1] } }}
      style={{ pointerEvents: isPresent ? undefined : 'none' }}
    >
      <div className="card-head">
        <GroupIcon id={group.id} kind={group.kind} />
        <div className="card-titles">
          <div className="card-title">
            <span className="label">{group.label}</span>
            {group.protected && (
              <span className="lock" title="Contient des processus protégés" aria-label="Contient des processus protégés" role="img">
                <Lock size={12} strokeWidth={2.4} />
              </span>
            )}
            {leak && <LeakBadge onClick={stop(() => actions.leak(group.id))} />}
          </div>
          <div className="sub" title={sub}>{sub}</div>
        </div>
      </div>
      <AnimatedNumber className="big" value={total} />
      <Sparkline values={spark} tone={cardTone(pct)} height={28} />
      <div className="bar"><i className={`tone-${cardTone(pct)}`} style={{ width: barWidth(pct) }} /></div>
      <div className="card-foot">
        <span className="mono">
          {formatCpu(group.cpuPercent)} CPU · <span className={group.oldestAgeSec > DAY ? 'old' : ''}>{formatAge(group.oldestAgeSec)}</span>
        </span>
        {group.kind !== 'others' &&
          (stuck ? (
            <ForceButton onClick={stop(() => actions.force(group.id))} />
          ) : (
            <KillButton pending={pending} disabled={!group.killable} onClick={stop(() => actions.kill(group.id))} />
          ))}
      </div>
    </motion.div>
  );
}

/** Ne se re-rend que si ce qu'elle affiche change (voir cardDisplayEqual). */
export const GroupCard = memo(
  GroupCardImpl,
  (a, b) =>
    a.actions === b.actions &&
    a.ref === b.ref &&
    a.layoutKey === b.layoutKey &&
    a.stuck === b.stuck &&
    a.pending === b.pending &&
    a.leak === b.leak &&
    sameSeries(a.spark, b.spark) &&
    cardDisplayEqual(a.group, b.group, a.memTotalKB, b.memTotalKB),
);
