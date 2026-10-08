import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, ChartLine, ChevronRight, Lock, Shield, ShieldOff, X } from 'lucide-react';
import type { Category, GroupSummary as Group, InstanceSummary, ProcNode, RangePreset } from '../../../core/types';
import { formatAge, formatKB } from '../format';
import { procSparkMap, useHistory } from '../history';
import { ticksIndex } from '../instances';
import { useChartZoom, ZoomChip } from '../chartZoom';
import { PRESET_MS, refreshMsFor } from '../metrics';
import { groupChartSeries } from './charts/chartData';
import { TimeChart } from './charts/TimeChart';
import { KB_FORMAT, PERCENT_FORMAT } from './charts/uplotTheme';
import { InstancesPanel } from './InstancesPanel';
import { ProcTree } from './ProcTree';
import { RangeSelector } from './RangeSelector';
import { AnimatedNumber, ForceButton, GroupIcon } from './ui';

interface Props {
  group: Group | undefined;
  /** Arbre du groupe (envoyé par le main pour le seul groupe ouvert) ; null tant qu'il n'est pas arrivé. */
  roots: ProcNode[] | null;
  /** Le main n'a pas encore répondu au `watch` de ce groupe : ne pas conclure qu'il a disparu. */
  pending: boolean;
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
  onReclassify: (inst: InstanceSummary, category: Category | null) => void;
  onKillInstance: (inst: InstanceSummary) => void;
  /** Dialogue de confirmation groupée (Task 9) pré-filtré ; absent : boutons d'en-tête de « Instances » désactivés. */
  onKillInstances?: (instances: InstanceSummary[], launchersOf?: string) => void;
}


function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button className="back" title="Retour" aria-label="Retour" onClick={onBack}>
      <ArrowLeft size={16} strokeWidth={2} />
    </button>
  );
}

const CHART_FORMAT = { left: KB_FORMAT, right: PERCENT_FORMAT };

/** Panneau « Historique » : RAM, swap et CPU du groupe sur la plage choisie, avec les mêmes gestes que l'onglet Métriques. */
function GroupHistoryPanel({ groupId }: { groupId: string }) {
  const [range, setRange] = useState<RangePreset>('1h');
  const z = useChartZoom(PRESET_MS[range]);
  const h = useHistory(() => window.procWatch.history.group(groupId, z.range()), [groupId, range, z.zoom], refreshMsFor(range, z.frozen));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => z.onData(), [h]);
  const series = useMemo(() => (h ? groupChartSeries(h) : []), [h]);
  const [hover, setHover] = useState<number | null>(null);
  const enough = !!h && h.ts.length >= 2;
  const pickRange = (r: RangePreset) => {
    z.setZoom(null);
    setRange(r);
  };
  return (
    <section className="chart-panel" data-testid="group-history">
      <div className="chart-panel-head">
        <h3><ChartLine size={14} strokeWidth={2} /> Historique</h3>
        {enough && (
          <span className="chart-legend" onMouseLeave={() => setHover(null)}>
            {(['lg-mem', 'lg-swap', 'lg-cpu'] as const).map((cls, i) => (
              <span key={cls} className={hover !== null && hover !== i ? 'dim' : ''} onMouseEnter={() => setHover(i)}>
                <i className={cls} />{series[i]?.label}
              </span>
            ))}
          </span>
        )}
        <span className="spacer" />
        <ZoomChip zoom={z.zoom} onReset={() => z.setZoom(null)} />
        <RangeSelector value={range} onChange={pickRange} />
      </div>
      {enough ? (
        <TimeChart
          ts={h.ts}
          series={series}
          height={190}
          format={CHART_FORMAT}
          focusSeries={hover}
          xRange={z.view}
          onWheel={z.onWheel}
          onDragPan={z.onDragPan}
          onSelectRange={z.onSelectRange}
        />
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
  // Index pid → startTicks : même objet tant que l'arbre a les mêmes processus (lignes d'instances mémoïsées).
  const ticksRef = useRef<Map<number, number> | undefined>(undefined);
  const ticksOf = useMemo(() => (ticksRef.current = ticksIndex(props.roots, ticksRef.current)), [props.roots]);
  if (!group && props.pending) return <p className="empty">Chargement…</p>;
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
      {(group.kind === 'project' || group.kind === 'deleted') && group.instances.length > 0 && (
        <InstancesPanel
          group={group}
          sparks={sparks}
          ticksOf={ticksOf}
          stuckPids={props.stuckPids}
          pendingPids={props.pendingPids}
          onReclassify={props.onReclassify}
          onKillInstance={props.onKillInstance}
          onForce={props.onForce}
          onKillInstances={props.onKillInstances}
        />
      )}
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
      ) : !props.roots ? (
        <div className="panel"><p className="empty">Chargement…</p></div>
      ) : (
        <ProcTree
          roots={props.roots}
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
