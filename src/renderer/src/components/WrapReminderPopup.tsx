// Rappel au lancement « Commandes lourdes : les lancer dans le budget » : une seule fois tant qu'on n'a pas répondu.
// Pop-up en tête de pile (comme celui d'earlyoom), aucune notification du bureau. « Plus tard » et « Voir le réglage » :
// revient au prochain lancement ; « Ne plus afficher » et une installation complète : plus jamais (wrap-setup.json, tenu
// par le main). Rien en test (PROC_WATCH_NO_*, e2e) : décidé par le main.
import { useCallback, useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Rocket, Settings2, X } from 'lucide-react';
import { WRAP_REMINDER } from '../wrapSetupView';
import { WRAP_SETUP_CHANGED } from './WrapSetupCard';
import '../earlyoomSetup.css';
import '../wrapSetup.css';

export function useWrapReminder(onOpen: () => void) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    window.procWatch.wrapSetup.reminder().then(setShown, () => {});
    // installé depuis Réglages : redemandé au main (tout en place → fermé pour de bon)
    const changed = () => window.procWatch.wrapSetup.reminder().then((s) => !s && setShown(false), () => {});
    window.addEventListener(WRAP_SETUP_CHANGED, changed);
    return () => window.removeEventListener(WRAP_SETUP_CHANGED, changed);
  }, []);
  const answer = useCallback((kind: 'go' | 'later' | 'never') => {
    setShown(false);
    void window.procWatch.wrapSetup.remind(kind === 'never' ? 'never' : 'later').catch(() => {});
    if (kind === 'go') onOpen();
  }, [onOpen]);
  return { shown, answer };
}

export function WrapReminderPopup({ onAnswer }: { onAnswer: (kind: 'go' | 'later' | 'never') => void }) {
  const t = WRAP_REMINDER;
  return (
    <motion.div
      className="alert-popup eo-setup-popup wrap-reminder"
      data-testid="wrap-reminder"
      role="alertdialog"
      aria-label={t.title}
      initial={{ opacity: 0, x: 40, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, transition: { duration: 0.18 } }}
      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
    >
      <span className="alert-popup-ico" aria-hidden>
        <Rocket size={15} strokeWidth={2.2} />
      </span>
      <div className="alert-popup-main">
        <div className="alert-popup-head">
          <strong title={t.title}>{t.title}</strong>
        </div>
        <p>{t.body}</p>
        <div className="alert-popup-actions eo-setup-actions">
          <button className="alert-popup-go" data-testid="wrap-reminder-go" onClick={() => onAnswer('go')}>
            <Settings2 size={12} strokeWidth={2.2} />
            {t.go}
          </button>
          <button data-testid="wrap-reminder-later" onClick={() => onAnswer('later')}>{t.later}</button>
          <button data-testid="wrap-reminder-never" onClick={() => onAnswer('never')}>{t.never}</button>
        </div>
      </div>
      <button className="alert-popup-x" aria-label="Fermer (rappel au prochain lancement)" title="Fermer" onClick={() => onAnswer('later')}>
        <X size={13} strokeWidth={2.4} />
      </button>
    </motion.div>
  );
}
