import { formatAge } from '../format';
import type { KillRequest } from '../viewModel';

export function ConfirmDialog({ request, onConfirm, onCancel }: { request: KillRequest; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="overlay" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{request.title}</h3>
        {request.protectedProcs.length > 0 && (
          <>
            <p>⚠ {request.protectedProcs.length} processus protégé(s) seront tués :</p>
            <div className="prot-list">
              {request.protectedProcs.map((p) => (
                <div key={p.pid}>
                  <div className="mono">{p.cmdline}</div>
                  <div className="mono">PID {p.pid} · {p.cwd ?? 'dossier inconnu'} · depuis {formatAge(p.ageSec)}</div>
                </div>
              ))}
            </div>
          </>
        )}
        <div className="actions">
          <button onClick={onCancel}>Annuler</button>
          <button className="danger" onClick={onConfirm} autoFocus>Tuer</button>
        </div>
      </div>
    </div>
  );
}
