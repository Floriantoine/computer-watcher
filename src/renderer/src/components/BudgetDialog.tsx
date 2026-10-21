import { useEffect, useRef, useState } from 'react';
import { motion, useIsPresent } from 'motion/react';
import { Snowflake } from 'lucide-react';
import { formatGoInput, validateBudget } from '../antigel';
import { useFocusTrap } from '../focusTrap';

/** « Budget mémoire… » d'un projet : MemoryHigh de sa slice de projet (Go) ; vide refusé, « Retirer le budget » si déjà posé. */
export function BudgetDialog({ label, currentMB, onSave, onCancel }: { label: string; currentMB: number | null; onSave: (mb: number | null) => void; onCancel: () => void }) {
  const isPresent = useIsPresent();
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(box);
  const [text, setText] = useState(currentMB === null ? '' : formatGoInput(currentMB));
  const v = validateBudget(text);
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
  const showError = !v.ok && text.trim() !== '';
  return (
    <motion.div className="overlay" onClick={guard(onCancel)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}
      style={{ pointerEvents: isPresent ? undefined : 'none' }}>
      <motion.div ref={box} className="dialog" role="dialog" aria-modal="true" aria-labelledby="budget-title" data-testid="antigel-budget-dialog"
        onClick={(e) => e.stopPropagation()} initial={{ opacity: 0, scale: 0.94, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 6, transition: { duration: 0.14 } }}>
        <div className="dialog-head">
          <span className="ico" aria-hidden><Snowflake size={17} strokeWidth={2} /></span>
          <h3 id="budget-title">Budget mémoire : {label}</h3>
        </div>
        <p className="sub">Au-delà, la mémoire de ce projet est ralentie (MemoryHigh de sa slice de projet). Le plafond de travail global s’applique toujours. Sans budget propre, le projet a le budget par défaut (Réglages → Plafond de travail).</p>
        <label className="budget-field">
          En Go
          <input data-testid="antigel-budget-input" autoFocus aria-describedby={showError ? 'budget-error' : undefined} aria-invalid={showError} inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && v.ok && isPresent) onSave(v.mb); }} />
        </label>
        {!v.ok && showError && <p id="budget-error" role="alert" className="warn-line">{v.error}</p>}
        <div className="actions">
          {currentMB !== null && <button data-testid="antigel-budget-remove" onClick={guard(() => onSave(null))}>Retirer le budget</button>}
          <button onClick={guard(onCancel)}>Annuler</button>
          <button data-testid="antigel-budget-save" disabled={!v.ok} onClick={guard(() => { if (v.ok) onSave(v.mb); })}>Enregistrer</button>
        </div>
      </motion.div>
    </motion.div>
  );
}
