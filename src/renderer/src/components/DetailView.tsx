import { useCallback, useMemo, useRef } from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, ChevronRight, History, Lock, Shield, ShieldOff, X } from 'lucide-react';
import type { Category, GroupSummary as Group, InstanceSummary, ProcNode } from '../../../core/types';
import { formatAge, formatKB } from '../format';
import { procSparkMap, useHistory } from '../history';
import { GroupHistoryPanel } from './GroupHistoryPanel';
import { ticksIndex } from '../instances';
import { formatInstant } from '../metrics';
import { liveKeySet, replayEmptyText, replayTree } from '../replay';
import { useReplay, type Replay } from '../useReplay';
import { InstancesPanel } from './InstancesPanel';
import { ProcTree } from './ProcTree';
import { ReplayTree } from './ReplayTree';
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
  /** Dialogue de confirmation groupée (BulkKillDialog) pré-filtré ; absent : boutons d'en-tête de « Instances » désactivés. */
  onKillInstances?: (instances: InstanceSummary[], launchersOf?: string) => void;
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button className="back" title="Retour" aria-label="Retour" onClick={onBack}>
      <ArrowLeft size={16} strokeWidth={2} />
    </button>
  );
}

/** Arbre reconstruit à l'instant examiné, à la place de l'arbre en direct. */
function ReplayPanel({ replay, liveRoots }: { replay: Replay; liveRoots: ProcNode[] | null }) {
  const instant = replay.instant!;
  const tree = replay.tree;
  const live = useMemo(() => liveKeySet(liveRoots), [liveRoots]);
  // Tant que l'arbre en direct n'est pas arrivé, personne n'est déclaré mort.
  const nodes = useMemo(
    () => (tree ? replayTree(tree.procs, (pid, st) => liveRoots === null || live.has(`${pid}:${st}`)) : []),
    [tree, live, liveRoots],
  );
  return (
    <div className="panel replay-panel">
      <div className="panel-head replay-banner" data-testid="replay-banner">
        <History size={14} strokeWidth={2} />
        {/* Instant de l'arbre affiché (l'arbre précédent reste à l'écran pendant le chargement du suivant). */}
        <h3>Arbre au {formatInstant(tree ? tree.ts : instant)}</h3>
        <span className="sub">
          — seuls les processus au-dessus des seuils d'enregistrement apparaissent{tree?.source === 'minute' ? ' (moyennes par minute)' : ''}
        </span>
        <span className="spacer" />
        <button className="tree-toggle-all" data-testid="replay-live" onClick={replay.live}>Revenir au direct</button>
      </div>
      {tree === undefined ? (
        <p className="empty">Chargement…</p>
      ) : tree === null ? (
        <p className="empty">Historique indisponible</p>
      ) : nodes.length === 0 ? (
        <p className="empty" data-testid="replay-empty">{replayEmptyText(tree)}</p>
      ) : (
        <ReplayTree nodes={nodes} at={tree.ts} omitted={tree.omitted} />
      )}
    </div>
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
  const replay = useReplay(groupId ?? '');
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
      {!others && <GroupHistoryPanel key={group.id} groupId={group.id} replay={replay} />}
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
      ) : replay.instant !== null ? (
        <ReplayPanel replay={replay} liveRoots={props.roots} />
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
