import { memo } from 'react';
import { Lock, Plug, Unplug } from 'lucide-react';
import type { OpenPort, OpenPortsInfo } from '../../../core/openPorts';
import { formatAge } from '../format';
import { freePortLabel, portRowsFor, portSearchEmpty } from '../ports';
import { CategoryTag } from './CategoryTag';

export interface PortRowProps {
  row: OpenPort;
  pending: boolean;
  onFree: (row: OpenPort) => void;
  onOpenGroup: (groupId: string) => void;
}

/**
 * Une ligne de port : port, libellé, catégorie, groupe, ancienneté. « Libérer :port » seulement pour une instance non protégée
 * d'un projet (`freeable`) ; toute autre ligne n'offre que « Voir le groupe » (et « protégé » si elle l'est).
 */
function PortRowImpl({ row, pending, onFree, onOpenGroup }: PortRowProps) {
  return (
    <div className="port-row" role="row" data-testid="port-row">
      <span className="port-num mono" role="cell">:{row.port}</span>
      <span className="port-label mono" role="cell" title={`${row.label} · PID ${row.pid}`}>{row.label}</span>
      <span role="cell">{row.category ? <CategoryTag category={row.category} /> : <span className="muted">—</span>}</span>
      <span className="port-project" role="cell" title={row.project ?? row.groupLabel}>{row.groupLabel}</span>
      <span className="num mono" role="cell">{formatAge(row.ageSec)}</span>
      <span className="port-act" role="cell">
        {row.freeable ? (
          <button
            type="button"
            className={`danger free-port${pending ? ' is-pending' : ''}`}
            data-testid="free-port"
            aria-busy={pending || undefined}
            title={`Tuer l'instance « ${row.label} »`}
            onClick={() => onFree(row)}
          >
            <Unplug size={12} strokeWidth={2.4} />
            {freePortLabel(row.port)}
          </button>
        ) : (
          <>
            {row.protected && (
              <span className="port-protected" data-testid="port-protected" title="Protégé : pas d'arrêt depuis la liste des ports">
                <Lock size={11} strokeWidth={2.4} /> protégé
              </span>
            )}
            <button type="button" className="link-btn" data-testid="port-open-group" onClick={() => onOpenGroup(row.groupId)}>
              Voir le groupe
            </button>
          </>
        )}
      </span>
    </div>
  );
}

/** Même affichage → pas de re-rendu (les lignes sont recréées à chaque snapshot, l'ancienneté change toutes les secondes). */
export function portRowEqual(a: PortRowProps, b: PortRowProps): boolean {
  const x = a.row;
  const y = b.row;
  return (
    a.pending === b.pending && a.onFree === b.onFree && a.onOpenGroup === b.onOpenGroup &&
    x.port === y.port && x.pid === y.pid && x.startTicks === y.startTicks && x.instanceKey === y.instanceKey && x.label === y.label &&
    x.category === y.category && x.groupId === y.groupId && x.groupLabel === y.groupLabel && x.project === y.project &&
    x.protected === y.protected && x.freeable === y.freeable && formatAge(x.ageSec) === formatAge(y.ageSec)
  );
}
export const PortRow = memo(PortRowImpl, portRowEqual);

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
  onOpenGroup: (groupId: string) => void;
}

/** Résultat d'une recherche `:port` au-dessus des cartes : qui tient ce port, avec « Libérer :port ». */
export function PortResults({ port, info, pendingPids, onFree, onOpenGroup }: Props) {
  const rows = info ? portRowsFor(info, port) : [];
  return (
    <section className="chart-panel port-results" data-testid="port-results">
      <div className="chart-panel-head">
        <h3><Plug size={14} strokeWidth={2} /> Qui écoute :{port} ?</h3>
      </div>
      {!info ? (
        <p className="port-empty port-pending" data-testid="port-pending">Recherche des ports…</p>
      ) : rows.length === 0 ? (
        <p className="port-empty" data-testid="port-empty">{portSearchEmpty(port, info)}</p>
      ) : (
        <div className="port-rows" role="table" aria-label={`Processus qui écoutent :${port}`}>
          <PortRowsHead />
          {rows.map((r) => <PortRow key={`${r.port}:${r.pid}`} row={r} pending={pendingPids.has(r.pid)} onFree={onFree} onOpenGroup={onOpenGroup} />)}
        </div>
      )}
    </section>
  );
}
