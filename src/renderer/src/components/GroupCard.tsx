import type { MouseEvent } from 'react';
import type { Group } from '../../../core/types';
import { formatAge, formatCpu, formatKB } from '../format';

const ICONS: Record<Group['kind'], string> = { claude: '🤖', app: '🪟', project: '📁', deleted: '🗑️', command: '⚙️', others: '📦' };
const DAY = 86400;

interface Props {
  group: Group;
  memTotalKB: number;
  stuck: boolean;
  onOpen: () => void;
  onKill: () => void;
  onForce: () => void;
}

export function GroupCard({ group, memTotalKB, stuck, onOpen, onKill, onForce }: Props) {
  const total = group.rssKB + group.swapKB;
  const pct = Math.min(100, (total / memTotalKB) * 100);
  const level = pct >= 20 ? 'bad' : pct >= 8 ? 'warn' : 'ok';
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <div className="card" data-testid="group-card" onClick={onOpen}>
      <div className="card-head">
        <span className="card-title">{ICONS[group.kind]} {group.label}</span>
        {group.protected && <span title="Contient des processus protégés">🔒</span>}
      </div>
      <div className="card-big">{formatKB(total)}</div>
      <div className="gauge"><i className={level} style={{ width: `${pct}%` }} /></div>
      <div className="mono">
        {group.procCount} proc · {formatCpu(group.cpuPercent)} CPU ·{' '}
        <span className={group.oldestAgeSec > DAY ? 'old' : ''}>{formatAge(group.oldestAgeSec)}</span>
      </div>
      {group.tags.length > 0 && <div>{group.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>}
      {group.kind !== 'others' && (
        <div className="card-actions">
          {stuck ? (
            <button className="danger" onClick={stop(onForce)}>Forcer (SIGKILL)</button>
          ) : (
            <button className="danger" disabled={!group.killable} onClick={stop(onKill)}>Kill</button>
          )}
        </div>
      )}
    </div>
  );
}
