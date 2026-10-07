import type { Group, ProcNode } from '../../../core/types';
import { formatAge, formatKB } from '../format';
import { ProcTree } from './ProcTree';

interface Props {
  group: Group | undefined;
  stuckPids: Set<number>;
  currentUid: number;
  rootProtectedByName: boolean;
  onBack: () => void;
  onOpenGroup: (id: string) => void;
  onKillGroup: (g: Group) => void;
  onKillProc: (node: ProcNode) => void;
  onForce: (pids: number[]) => void;
  onToggleProtect: (g: Group) => void;
}

export function DetailView(props: Props) {
  const { group, onBack } = props;
  if (!group) {
    return (
      <div className="empty">
        Groupe terminé : plus aucun de ses processus ne tourne. <button onClick={onBack}>← Retour</button>
      </div>
    );
  }
  const stuck = group.pids.filter((pid) => props.stuckPids.has(pid));
  return (
    <>
      <div className="detail-head">
        <button className="link" onClick={onBack}>← Retour</button>
        <h2>{group.protected ? '🔒 ' : ''}{group.label}</h2>
        <span className="spacer" />
        {group.kind !== 'others' && (
          <button onClick={() => props.onToggleProtect(group)}>
            {props.rootProtectedByName ? `Retirer la protection de « ${group.rootName} »` : `Protéger « ${group.rootName} »`}
          </button>
        )}
        {group.kind !== 'others' &&
          (stuck.length ? (
            <button className="danger" onClick={() => props.onForce(stuck)}>Forcer (SIGKILL)</button>
          ) : (
            <button className="danger" disabled={!group.killable} onClick={() => props.onKillGroup(group)}>Tuer le groupe</button>
          ))}
      </div>
      <div className="summary">
        <div><b>Processus</b><span>{group.procCount}</span></div>
        <div><b>RAM</b><span>{formatKB(group.rssKB)}</span></div>
        <div><b>Swap</b><span>{formatKB(group.swapKB)}</span></div>
        <div><b>Plus ancien</b><span className={group.oldestAgeSec > 86400 ? 'old' : ''}>{formatAge(group.oldestAgeSec)}</span></div>
      </div>
      {group.subgroups.length > 0 ? (
        group.subgroups.map((sg) => (
          <div key={sg.id} className="subgroup" onClick={() => props.onOpenGroup(sg.id)}>
            <span>{sg.label}</span>
            <span className="mono">{sg.procCount} proc · {formatKB(sg.rssKB + sg.swapKB)} · {formatAge(sg.oldestAgeSec)}</span>
          </div>
        ))
      ) : (
        <ProcTree
          roots={group.roots}
          stuckPids={props.stuckPids}
          currentUid={props.currentUid}
          onKill={props.onKillProc}
          onForce={(pid) => props.onForce([pid])}
        />
      )}
    </>
  );
}
