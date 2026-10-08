import { useRef, type ReactNode } from 'react';
import { motion, useIsPresent } from 'motion/react';
import { Trash2 } from 'lucide-react';
import { useFocusTrap } from '../focusTrap';

interface ConfirmProps {
  id: string;
  title: string;
  text: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Icône de l'en-tête (corbeille par défaut). */
  icon?: ReactNode;
  /** Contenu affiché sous le texte (ex. la ligne exacte à appliquer). */
  children?: ReactNode;
  /** Focus initial sur « Annuler » (action risquée : Entrée ne confirme pas par mégarde). */
  focusCancel?: boolean;
}

export function SettingsConfirm({ id, title, text, confirmLabel, onConfirm, onCancel, icon, children, focusCancel }: ConfirmProps) {
  const isPresent = useIsPresent();
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(box);
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
        ref={box}
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={id}
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.94, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 6, transition: { duration: 0.14 } }}
        transition={{ type: 'spring', stiffness: 420, damping: 28, mass: 0.8 }}
      >
        <div className="dialog-head">
          <span className="ico" aria-hidden>{icon ?? <Trash2 size={17} strokeWidth={2} />}</span>
          <h3 id={id}>{title}</h3>
        </div>
        <p className="hint" style={{ margin: 0 }}>{text}</p>
        {children}
        <div className="actions">
          <button onClick={guard(onCancel)} autoFocus={focusCancel} data-testid={focusCancel ? 'confirm-cancel' : undefined}>Annuler</button>
          <button className="danger" onClick={guard(onConfirm)}>{confirmLabel}</button>
        </div>
      </motion.div>
    </motion.div>
  );
}
