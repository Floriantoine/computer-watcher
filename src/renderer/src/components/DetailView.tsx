import { useCallback, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, ChartLine, ChevronRight, Lock, Shield, ShieldOff, X } from 'lucide-react';
import type { Group, ProcNode, RangePreset } from '../../../core/types';
import { formatAge, formatKB } from '../format';
import { procSparkMap, useHistory } from '../history';
import { groupChartSeries } from './charts/chartData';
import { TimeChart } from './charts/TimeChart';
import { KB_FORMAT, PERCENT_FORMAT } from './charts/uplotTheme';
import { ProcTree } from './ProcTree';
import { RangeSelector } from './RangeSelector';
import { AnimatedNumber, ForceButton, GroupIcon } from './ui';

interface Props {
  group: Group | undefined;
  stuckPids: Set<number>;
  pendingPids: Set<number>;
  currentUid: number;
  rootProtectedByName: boolean;
  onBack: () => void;
  onOpenGroup: (id: string) => void;
  onKillGroup: (g: Group) => void;
  onKillProc: (node: ProcNode) => void;
  onForce: (pids: number[]) => void;
  onToggleProtect: (g: Group) => void;
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button className="back" title="Retour" aria-label="Retour" onClick={onBack}>
      <ArrowLeft size={16} strokeWidth={2} />
    </button>
  );
}

const CHART_FORMAT = { left: KB_FORMAT, right: PERCENT_FORMAT };

/** Panneau « Historique » : RAM + swap empilés et CPU du groupe sur la plage choisie. */
function GroupHistoryPanel({ groupId }: { groupId: string }) {
  const [range, setRange] = useState<RangePreset>('1h');
  const h = useHistory(() => window.procWatch.history.group(groupId, range), [groupId, range]);
  const series = useMemo(() => (h ? groupChartSeries(h) : []), [h]);
  const enough = !!h && h.ts.length >= 2;
  return (
    <section className="chart-panel" data-testid="group-history">
      <div className="chart-panel-head">
        <h3><ChartLine size={14} strokeWidth={2} /> Historique</h3>
        {enough && (
          <span className="chart-legend">
            <span><i className="lg-mem" />RAM</span>
            <span><i className="lg-swap" />Swap</span>
            <span><i className="lg-cpu" />CPU</span>
          </span>
        )}
        <span className="spacer" />
        <RangeSelector value={range} onChange={setRange} />
      </div>
      {enough ? (
        <TimeChart ts={h.ts} series={series} height={190} format={CHART_FORMAT} />
      ) : (
        <div className="chart-empty">{h === undefined ? 'Chargement…' : "Pas encore d'historique pour ce groupe"}</div>
      )}
    </section>
  );
}

export function DetailView(props: Props) {
  const { group, onBack } = props;
  const groupId = group?.id;
  const others = group?.kind === 'others';
  const procs = useHistory(
    () => (groupId && !others ? window.procWatch.history.procs(groupId, '1h') : Promise.resolve(null)),
    [groupId, others],
  );
  const sparks = useMemo(() => procSparkMap(procs), [procs]);
  const sparkOf = useCallback((pid: number, startTicks: number) => sparks.get(`${pid}:${startTicks}`), [sparks]);
  if (!group) {
    return (
      <div className="empty">
        Groupe terminé : plus aucun de ses processus ne tourne.
        <button onClick={onBack}><ArrowLeft size={14} strokeWidth={2} /> Retour</button>
      </div>
    );
  }
  const stuck = group.pids.filter((pid) => props.stuckPids.has(pid));
  const pending = group.pids.some((pid) => props.pendingPids.has(pid));
  return (
    <>
      <div className="page-head">
        <BackButton onBack={onBack} />
        <GroupIcon id={group.id} kind={group.kind} size="lg" />
        <h2>
          <span className="label">{group.label}</span>
          {group.protected && (
            <span className="lock" title="Contient des processus protégés" aria-label="Contient des processus protégés" role="img">
              <Lock size={14} strokeWidth={2.4} />
            </span>
          )}
        </h2>
        <span className="spacer" />
        {group.kind !== 'others' && (
          <button onClick={() => props.onToggleProtect(group)}>
            {props.rootProtectedByName ? <ShieldOff size={14} strokeWidth={2} /> : <Shield size={14} strokeWidth={2} />}
            {props.rootProtectedByName ? `Retirer la protection de « ${group.rootName} »` : `Protéger « ${group.rootName} »`}
          </button>
        )}
        {group.kind !== 'others' &&
          (stuck.length ? (
            <ForceButton onClick={() => props.onForce(stuck)} />
          ) : (
            <motion.button
              className={`danger ${pending ? 'is-pending' : ''}`}
              disabled={!group.killable}
              whileTap={group.killable ? { scale: 0.95 } : undefined}
              onClick={() => props.onKillGroup(group)}
            >
              <X size={14} strokeWidth={2.4} />
              Tuer le groupe
            </motion.button>
          ))}
      </div>
      <div className="summary">
        <div className="tile"><small>Processus</small><b>{group.procCount}</b></div>
        <div className="tile"><small>RAM</small><b><AnimatedNumber value={group.rssKB} /></b></div>
        <div className="tile"><small>Swap</small><b><AnimatedNumber value={group.swapKB} /></b></div>
        <div className="tile"><small>Plus ancien</small><b className={group.oldestAgeSec > 86400 ? 'old' : ''}>{formatAge(group.oldestAgeSec)}</b></div>
      </div>
      {!others && <GroupHistoryPanel key={group.id} groupId={group.id} />}
      {group.subgroups.length > 0 ? (
        <div className="subgroups">
          {group.subgroups.map((sg) => (
            <div key={sg.id} className="subgroup" onClick={() => props.onOpenGroup(sg.id)}>
              <GroupIcon id={sg.id} kind={sg.kind} size="sm" />
              <span className="name">{sg.label}</span>
              <span className="mono">{sg.procCount} proc · {formatKB(sg.rssKB + sg.swapKB)} · {formatAge(sg.oldestAgeSec)}</span>
              <ChevronRight size={15} strokeWidth={2} />
            </div>
          ))}
        </div>
      ) : (
        <ProcTree
          roots={group.roots}
          stuckPids={props.stuckPids}
          pendingPids={props.pendingPids}
          currentUid={props.currentUid}
          sparkOf={sparkOf}
          onKill={props.onKillProc}
          onForce={(pid) => props.onForce([pid])}
        />
      )}
    </>
  );
}
