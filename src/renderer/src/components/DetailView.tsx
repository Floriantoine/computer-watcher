import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, ChevronRight, Lock, PenLine, Shield, ShieldOff, X } from 'lucide-react';
import type { Category, GroupSummary as Group, InstanceSummary, MemoryMetric, ProcNode } from '../../../core/types';
import { formatAge, formatKB } from '../format';
import { procSparkMap, useHistory } from '../history';
import { GroupHistoryPanel } from './GroupHistoryPanel';
import { showRevertToAuto, ticksIndex } from '../instances';
import { headerReclassTarget } from '../reclassHeader';
import { escapeUnpins, killAllowed } from '../replay';
import { useReplaySelect, useReplayStore } from '../useReplay';
import { DetailTilesLive } from './DetailTiles';
import { CategoryTag } from './CategoryTag';
import { InstancesPanel } from './InstancesPanel';
import { ReclassMenu } from './ReclassMenu';
import { ProcTree } from './ProcTree';
import { ReplayPanelLive } from './ReplayPanel';
import { ForceButton, GroupIcon } from './ui';

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
  /** Mémoire affichée en direct (RSS ou PSS) ; l'historique reste en RSS (« RAM »). */
  memMetric?: MemoryMetric;
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button className="back" title="Retour" aria-label="Retour" onClick={onBack}>
      <ArrowLeft size={16} strokeWidth={2} />
    </button>
  );
}

export function DetailView(props: Props) {
  const { group, onBack, memMetric = 'rss' } = props;
  const groupId = group?.id;
  const others = group?.kind === 'others';
  const procs = useHistory(
    () => (groupId && !others ? window.procWatch.history.procs(groupId, '1h') : Promise.resolve(null)),
    [groupId, others],
  );
  const sparks = useMemo(() => procSparkMap(procs), [procs]);
  const replay = useReplayStore(groupId ?? '');
  // Le détail ne se re-rend qu'au passage direct ↔ instant examiné (le survol re-rend seulement tuiles et arbre rejoué).
  const examining = useReplaySelect(replay, (c) => c.shown !== null);
  const sparkOf = useCallback((pid: number, startTicks: number) => sparks.get(`${pid}:${startTicks}`), [sparks]);
  // Index pid → startTicks : même objet tant que l'arbre a les mêmes processus (lignes d'instances mémoïsées).
  const ticksRef = useRef<Map<number, number> | undefined>(undefined);
  const ticksOf = useMemo(() => (ticksRef.current = ticksIndex(props.roots, ticksRef.current)), [props.roots]);
  // Menu « Reclasser » de l'en-tête : ouvert pour un groupe précis, donc fermé dès que le groupe affiché change.
  const [reclassOpenFor, setReclassOpenFor] = useState<string | null>(null);
  // Retour du rejeu au direct : l'arbre en direct (avec ses boutons de kill) apparaît sous la souris ; ses kills sont
  // ignorés pendant KILL_GUARD_MS (avant la peinture : useLayoutEffect).
  const returnedAt = useRef<number | null>(null);
  const wasExamining = useRef(examining);
  useLayoutEffect(() => {
    if (wasExamining.current && !examining) returnedAt.current = performance.now();
    wasExamining.current = examining;
  }, [examining]);
  const latestKill = useRef({ onKillProc: props.onKillProc, onForce: props.onForce });
  latestKill.current = { onKillProc: props.onKillProc, onForce: props.onForce };
  const guardedKill = useCallback((node: ProcNode) => {
    if (killAllowed(returnedAt.current, performance.now())) latestKill.current.onKillProc(node);
  }, []);
  const guardedForce = useCallback((pid: number) => {
    if (killAllowed(returnedAt.current, performance.now())) latestKill.current.onForce([pid]);
  }, []);
  // Échap : libère l'instant figé (retour au direct), sauf si un menu ou un dialogue a déjà traité la touche.
  const pinned = useReplaySelect(replay, (c) => c.state.instant !== null);
  const unpin = replay.c.live;
  useEffect(() => {
    if (!pinned) return;
    const onKey = (e: KeyboardEvent) => {
      const a = document.activeElement as HTMLElement | null;
      const ctx = {
        overlayOpen: !!document.querySelector('[aria-modal="true"], [role="dialog"], [role="menu"]'),
        editing: !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)),
      };
      if (escapeUnpins(e, ctx)) unpin();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinned, unpin]);
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
  // Groupes hors projet (app, commande, Claude) : leur instance unique se reclasse depuis l'en-tête (étiquette seulement).
  const reclass = headerReclassTarget(group);
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
        {reclass && (
          <span className="head-reclass" data-testid="header-reclass">
            <CategoryTag category={reclass.category} />
            {reclass.source === 'manual' && (
              <span className="inst-manual" title="Classé à la main" aria-label="Classé à la main" role="img">
                <PenLine size={11} strokeWidth={2.4} />
              </span>
            )}
            <ReclassMenu
              current={reclass.category}
              revert={showRevertToAuto(reclass)}
              open={reclassOpenFor === group.id}
              onOpen={(open) => setReclassOpenFor(open ? group.id : null)}
              onPick={(c) => {
                setReclassOpenFor(null);
                props.onReclassify(reclass, c);
              }}
            />
          </span>
        )}
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
      <DetailTilesLive store={replay} group={group} memMetric={memMetric} />
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
          memMetric={memMetric}
          liveOnly={examining}
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
      ) : examining ? (
        <ReplayPanelLive store={replay} liveRoots={props.roots} memMetric={memMetric} />
      ) : !props.roots ? (
        <div className="panel"><p className="empty">Chargement…</p></div>
      ) : (
        <ProcTree
          roots={props.roots}
          stuckPids={props.stuckPids}
          pendingPids={props.pendingPids}
          currentUid={props.currentUid}
          sparkOf={sparkOf}
          onKill={guardedKill}
          onForce={guardedForce}
          memMetric={memMetric}
        />
      )}
    </>
  );
}
