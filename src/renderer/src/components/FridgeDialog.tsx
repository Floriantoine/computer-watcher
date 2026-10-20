import { useEffect, useRef } from 'react';
import { motion, useIsPresent } from 'motion/react';
import { Refrigerator } from 'lucide-react';
import { useFocusTrap } from '../focusTrap';

/** « Mettre au frigo… » : confirmation (ce que le gel fait, ce qu'il ne fait pas). Réveiller n'a pas de dialogue (sens sûr). */
export function FridgeDialog({ label, procs, onConfirm, onCancel }: { label: string; procs: number | null; onConfirm: () => void; onCancel: () => void }) {
  const isPresent = useIsPresent();
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(box);
  const guard = (fn: () => void) => () => {
    if (isPresent) fn();
  };
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isPresent) onCancel();
    };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [isPresent, onCancel]);
  return (
    <motion.div className="overlay" onClick={guard(onCancel)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}
      style={{ pointerEvents: isPresent ? undefined : 'none' }}>
      <motion.div ref={box} className="dialog" role="dialog" aria-modal="true" aria-labelledby="fridge-title" data-testid="antigel-fridge-dialog"
        onClick={(e) => e.stopPropagation()} initial={{ opacity: 0, scale: 0.94, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 6, transition: { duration: 0.14 } }}>
        <div className="dialog-head">
          <span className="ico" aria-hidden><Refrigerator size={17} strokeWidth={2} /></span>
          <h3 id="fridge-title">Mettre « {label} » au frigo ?</h3>
        </div>
        <p className="sub">
          {procs ? `Ses ${procs} processus rangés sous le plafond de travail sont suspendus` : 'Ses processus rangés sous le plafond de travail sont suspendus'}, puis
          leur mémoire est poussée en swap autant que la swap libre le permet. Rien n’est arrêté : « Réveiller » les relance là où ils en étaient.
        </p>
        <p className="sub">Pendant ce temps, ses serveurs ne répondent plus. Ce que vous relancez dans ce projet tourne normalement, hors plafond, jusqu’au réveil.</p>
        <div className="actions">
          <button onClick={guard(onCancel)}>Annuler</button>
          <button data-testid="antigel-fridge-confirm" autoFocus onClick={guard(onConfirm)}>Mettre au frigo</button>
        </div>
      </motion.div>
    </motion.div>
  );
}
