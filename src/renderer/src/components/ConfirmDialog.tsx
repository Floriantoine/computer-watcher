import { motion, useIsPresent } from 'motion/react';
import { Skull, TriangleAlert } from 'lucide-react';
import { formatAge } from '../format';
import type { KillRequest } from '../viewModel';

export function ConfirmDialog({ request, onConfirm, onCancel }: { request: KillRequest; onConfirm: () => void; onCancel: () => void }) {
  // Pendant la sortie animée, le dialogue ne doit plus déclencher d'action (pas de double envoi).
  const isPresent = useIsPresent();
  const guard = (fn: () => void) => () => {
    if (isPresent) fn();
  };
  return (
    <motion.div
      className="overlay"
      onClick={guard(onCancel)}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      style={{ pointerEvents: isPresent ? undefined : 'none' }}
    >
      <motion.div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.94, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 6, transition: { duration: 0.14 } }}
        transition={{ type: 'spring', stiffness: 420, damping: 28, mass: 0.8 }}
      >
        <div className="dialog-head">
          <span className="ico" aria-hidden><Skull size={17} strokeWidth={2} /></span>
          <h3 id="confirm-title">{request.title}</h3>
        </div>
        {request.protectedProcs.length > 0 && (
          <>
            <p className="warn-line"><TriangleAlert size={15} strokeWidth={2.2} /> {request.protectedProcs.length} processus protégé(s) seront tués :</p>
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
          <button onClick={guard(onCancel)}>Annuler</button>
          <button className="danger" onClick={guard(onConfirm)} autoFocus>Tuer</button>
        </div>
      </motion.div>
    </motion.div>
  );
}
