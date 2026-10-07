import { motion } from 'motion/react';
import { ArrowLeft, ChevronRight, Lock, Shield, ShieldOff, X } from 'lucide-react';
import type { Group, ProcNode } from '../../../core/types';
import { formatAge, formatKB } from '../format';
import { ProcTree } from './ProcTree';
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

export function DetailView(props: Props) {
  const { group, onBack } = props;
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
            <span className="lock" title="Contient des processus protégés" aria-label="Contient des processus protégés">
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
          onKill={props.onKillProc}
          onForce={(pid) => props.onForce([pid])}
        />
      )}
    </>
  );
}
