import type { MouseEvent, Ref } from 'react';
import { motion, useIsPresent } from 'motion/react';
import { Lock } from 'lucide-react';
import type { Group } from '../../../core/types';
import { formatAge, formatCpu } from '../format';
import { cardTone } from '../theme';
import { Sparkline } from './charts/Sparkline';
import { AnimatedNumber, ForceButton, GroupIcon, KillButton } from './ui';

const DAY = 86400;

interface Props {
  group: Group;
  memTotalKB: number;
  spark: (number | null)[];
  stuck: boolean;
  pending: boolean;
  /** Change seulement quand l'ordre des cartes change : seul cas où le layout s'anime. */
  layoutKey: string;
  onOpen: () => void;
  onKill: () => void;
  onForce: () => void;
  ref?: Ref<HTMLDivElement>;
}

export function GroupCard({ group, memTotalKB, spark, stuck, pending, layoutKey, onOpen, onKill, onForce, ref }: Props) {
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
      onClick={guard(onOpen)}
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
          </div>
          <div className="sub" title={sub}>{sub}</div>
        </div>
      </div>
      <AnimatedNumber className="big" value={total} />
      <Sparkline values={spark} tone={cardTone(pct)} height={28} />
      <div className="bar"><i className={`tone-${cardTone(pct)}`} style={{ width: `${pct}%` }} /></div>
      <div className="card-foot">
        <span className="mono">
          {formatCpu(group.cpuPercent)} CPU · <span className={group.oldestAgeSec > DAY ? 'old' : ''}>{formatAge(group.oldestAgeSec)}</span>
        </span>
        {group.kind !== 'others' &&
          (stuck ? (
            <ForceButton onClick={stop(onForce)} />
          ) : (
            <KillButton pending={pending} disabled={!group.killable} onClick={stop(onKill)} />
          ))}
      </div>
    </motion.div>
  );
}
