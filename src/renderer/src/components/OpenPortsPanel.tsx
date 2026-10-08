import { Network } from 'lucide-react';
import type { OpenPort, OpenPortsInfo } from '../../../core/openPorts';
import { otherUsersNote, unreadableNote } from '../ports';
import { PortRow, PortRowsHead } from './PortResults';

interface Props {
  /** null : pas encore reçu du main */
  info: OpenPortsInfo | null;
  pendingPids: Set<number>;
  onFree: (row: OpenPort) => void;
  onOpenGroup: (groupId: string) => void;
}

/** Onglet Métriques : ports en écoute des processus de l'utilisateur, triés par port, avec « Libérer :port ». */
export function OpenPortsPanel({ info, pendingPids, onFree, onOpenGroup }: Props) {
  const note = info ? [otherUsersNote(new Set(info.otherUsers.map((o) => o.port)).size), unreadableNote(info.unreadable.length)].filter(Boolean).join(' · ') : '';
  return (
    <section className="chart-panel open-ports" data-testid="open-ports">
      <div className="chart-panel-head">
        <h3><Network size={14} strokeWidth={2} /> Ports ouverts</h3>
        {info && info.ports.length > 0 && <span className="count">{info.ports.length}</span>}
        <span className="spacer" />
        {note && (
          <span className="sub port-note" data-testid="other-users-note" title="Visibles dans /proc/net, mais leurs processus ne sont pas lisibles : non arrêtables depuis proc-watch">
            {note}
          </span>
        )}
      </div>
      {!info ? (
        <div className="chart-empty small">Chargement…</div>
      ) : info.ports.length === 0 ? (
        <div className="chart-empty small">Aucun de vos processus n'écoute de port TCP</div>
      ) : (
        <div className="port-rows" role="table" aria-label="Ports ouverts">
          <PortRowsHead />
          {info.ports.map((r) => <PortRow key={`${r.port}:${r.pid}`} row={r} pending={pendingPids.has(r.pid)} onFree={onFree} onOpenGroup={onOpenGroup} />)}
        </div>
      )}
    </section>
  );
}
