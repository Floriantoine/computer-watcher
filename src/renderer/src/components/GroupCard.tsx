import { memo, type MouseEvent, type Ref } from 'react';
import { motion, useIsPresent } from 'motion/react';
import { ChevronDown, ChevronUp, Lock } from 'lucide-react';
import type { GroupSummary as Group, MemoryMetric } from '../../../core/types';
import { hasDuplicate, instancesLine, primaryTag } from '../categoryFilter';
import { formatAge, formatCpu, formatKB } from '../format';
import { fallbackTitle, memLabel, memTileLabel } from '../memMetric';
import { othersPreview, othersPreviewEqual } from '../othersFold';
import { CategoryTag, DuplicateBadge } from './CategoryTag';
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
  /** Déplie / replie la carte (et la ligne) « Autres ». */
  toggleOthers: (open: boolean) => void;
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
  /** Carte « Autres » seulement : dépliée (aperçu de ses 10 plus gros sous-groupes). */
  othersOpen?: boolean;
  /** Mémoire affichée (libellé de l'infobulle du total). */
  memMetric?: MemoryMetric;
  ref?: Ref<HTMLDivElement>;
}

/** Bouton « Déplier » / « Replier » de la carte et de la ligne « Autres ». */
export function OthersToggle({ open, onToggle }: { open: boolean; onToggle: (e: MouseEvent) => void }) {
  const Chevron = open ? ChevronUp : ChevronDown;
  return (
    <button type="button" className="others-toggle" data-testid="others-toggle" aria-expanded={open} onClick={onToggle}>
      <Chevron size={13} strokeWidth={2.2} />
      {open ? 'Replier' : 'Déplier'}
    </button>
  );
}

/** Aperçu de « Autres » dépliée : ses 10 plus gros sous-groupes, puis « Voir tout (n) ». */
function OthersPreview({ group, onOpen }: { group: Group; onOpen: (id: string) => (e: MouseEvent) => void }) {
  if (group.subgroups.length === 0) return group.procCount > 0 ? <p className="others-loading">Chargement…</p> : null;
  const { shown } = othersPreview(group);
  return (
    <div className="others-fold">
      <ul className="others-preview" data-testid="others-preview">
        {shown.map((sg) => (
          <li key={sg.id}>
            <button type="button" onClick={onOpen(sg.id)} title={sg.label}>
              <GroupIcon id={sg.id} kind={sg.kind} size="sm" />
              <span className="label">{sg.label}</span>
              <span className="mono mem">{formatKB(sg.rssKB + sg.swapKB)}</span>
              <span className="mono cpu">{formatCpu(sg.cpuPercent)}</span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="others-see-all" data-testid="others-see-all" onClick={onOpen(group.id)}>
        Voir tout ({group.subgroups.length})
      </button>
    </div>
  );
}

function GroupCardImpl({ group, memTotalKB, spark, stuck, pending, leak, layoutKey, actions, othersOpen = false, memMetric = 'rss', ref }: Props) {
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
  const tag = primaryTag(group);
  const line = group.kind === 'project' || group.kind === 'deleted' ? instancesLine(group) : '';
  return (
    <motion.div
      ref={ref}
      className={othersOpen ? 'card others-open' : 'card'}
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
            {tag && <CategoryTag category={tag.category} port={tag.port} />}
            {!line && hasDuplicate(group) && <DuplicateBadge />}
            {leak && <LeakBadge onClick={stop(() => actions.leak(group.id))} />}
          </div>
          <div className="sub" title={sub}>{sub}</div>
        </div>
      </div>
      <div className="big-row">
        <AnimatedNumber className="big" value={total} title={[`${memLabel(memMetric)} + swap`, fallbackTitle(memMetric, group)].filter(Boolean).join('\n')} />
        {fallbackTitle(memMetric, group) && (
          <small className="mem-flag" data-testid="mem-flag" title={fallbackTitle(memMetric, group)}>{memTileLabel(memMetric, group)}</small>
        )}
      </div>
      {line && (
        <div className="instances-row">
          <span className="instances-line mono" data-testid="instances-line" title={line}>{line}</span>
          {hasDuplicate(group) && <DuplicateBadge />}
        </div>
      )}
      <Sparkline values={spark} tone={cardTone(pct)} height={28} />
      <div className="bar"><i className={`tone-${cardTone(pct)}`} style={{ width: barWidth(pct) }} /></div>
      {othersOpen && <OthersPreview group={group} onOpen={(id) => stop(() => actions.open(id))} />}
      <div className="card-foot">
        <span className="mono">
          {formatCpu(group.cpuPercent)} CPU · <span className={group.oldestAgeSec > DAY ? 'old' : ''}>{formatAge(group.oldestAgeSec)}</span>
        </span>
        {group.kind === 'others' ? (
          <OthersToggle open={othersOpen} onToggle={stop(() => actions.toggleOthers(!othersOpen))} />
        ) : stuck ? (
          <ForceButton onClick={stop(() => actions.force(group.id))} />
        ) : (
          <KillButton pending={pending} disabled={!group.killable} onClick={stop(() => actions.kill(group.id))} />
        )}
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
    a.othersOpen === b.othersOpen &&
    a.memMetric === b.memMetric &&
    sameSeries(a.spark, b.spark) &&
    cardDisplayEqual(a.group, b.group, a.memTotalKB, b.memTotalKB) &&
    (!a.othersOpen || othersPreviewEqual(a.group, b.group)),
);
