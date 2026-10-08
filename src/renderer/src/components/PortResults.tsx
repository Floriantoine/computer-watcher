import { memo } from 'react';
import { Plug, Unplug } from 'lucide-react';
import type { OpenPort, OpenPortsInfo } from '../../../core/openPorts';
import { formatAge } from '../format';
import { freePortLabel, portRowsFor, portSearchEmpty } from '../ports';
import { CategoryTag } from './CategoryTag';

interface RowProps {
  row: OpenPort;
  pending: boolean;
  onFree: (row: OpenPort) => void;
}

/** Une ligne de port : catégorie, projet, libellé, port, ancienneté et « Libérer :port » (jamais pour un autre utilisateur : pas de ligne). */
function PortRowImpl({ row, pending, onFree }: RowProps) {
  return (
    <div className="port-row" role="row" data-testid="port-row">
      <span className="port-num mono" role="cell">:{row.port}</span>
      <span className="port-label mono" role="cell" title={`${row.label} · PID ${row.pid}`}>{row.label}</span>
      <span role="cell">{row.category ? <CategoryTag category={row.category} /> : <span className="muted">—</span>}</span>
      <span className="port-project" role="cell" title={row.project ?? row.groupLabel}>{row.groupLabel}</span>
      <span className="num mono" role="cell">{formatAge(row.ageSec)}</span>
      <span className="port-act" role="cell">
        <button
          type="button"
          className={`danger free-port${pending ? ' is-pending' : ''}`}
          data-testid="free-port"
          aria-busy={pending || undefined}
          title={row.instanceKey ? `Tuer l'instance « ${row.label} »${row.protected ? ' (protégée : confirmation)' : ''}` : `Tuer le processus ${row.pid} (confirmation)`}
          onClick={() => onFree(row)}
        >
          <Unplug size={12} strokeWidth={2.4} />
          {freePortLabel(row.port)}
        </button>
      </span>
    </div>
  );
}
export const PortRow = memo(PortRowImpl);

export function PortRowsHead() {
  return (
    <div className="port-row port-head" role="row">
      <span role="columnheader">Port</span>
      <span role="columnheader">Instance</span>
      <span role="columnheader">Catégorie</span>
      <span role="columnheader">Projet</span>
      <span role="columnheader" className="num">Depuis</span>
      <span role="columnheader" className="sr-only">Actions</span>
    </div>
  );
}

interface Props {
  port: number;
  /** null : réponse du main pas encore reçue pour cette recherche */
  info: OpenPortsInfo | null;
  pendingPids: Set<number>;
  onFree: (row: OpenPort) => void;
}

/** Résultat d'une recherche `:port` au-dessus des cartes : qui tient ce port, avec « Libérer :port ». */
export function PortResults({ port, info, pendingPids, onFree }: Props) {
  const rows = info ? portRowsFor(info, port) : [];
  return (
    <section className="chart-panel port-results" data-testid="port-results">
      <div className="chart-panel-head">
        <h3><Plug size={14} strokeWidth={2} /> Qui écoute :{port} ?</h3>
      </div>
      {!info ? (
        <p className="port-empty">Recherche…</p>
      ) : rows.length === 0 ? (
        <p className="port-empty" data-testid="port-empty">{portSearchEmpty(port, info)}</p>
      ) : (
        <div className="port-rows" role="table" aria-label={`Processus qui écoutent :${port}`}>
          <PortRowsHead />
          {rows.map((r) => <PortRow key={`${r.port}:${r.pid}`} row={r} pending={pendingPids.has(r.pid)} onFree={onFree} />)}
        </div>
      )}
    </section>
  );
}
