// Pop-up « earlyoom n'est pas installé / pas actif / à mettre à jour » au lancement (B8 bis) : reste jusqu'à fermeture, aucune notification du bureau.
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { KeyRound, ShieldAlert, X } from 'lucide-react';
import { upgradeNeed, type EarlyoomReminderKind, type EarlyoomSetupMode, type EarlyoomUpgrade } from '../../../core/earlyoomSetup';
import type { ApplyResult, ConfigState } from '../../../core/types';
import { earlyoomPopupText, popupAfterSetup } from '../earlyoomPopup';
import '../earlyoomSetup.css';

type ToastFn = (m: string, kind?: 'error' | 'info') => void;

/** Diffusé après une installation / activation : Réglages › earlyoom relit l'état (point rouge compris). */
export const EARLYOOM_CHANGED = 'pw:earlyoom-changed';

/** Installer et configurer / Activer (confirmation native puis mot de passe dans le main), toast du résultat. */
export async function runEarlyoomSetup(mode: EarlyoomSetupMode, onToast: ToastFn): Promise<ApplyResult> {
  let r: ApplyResult;
  try {
    r = await window.procWatch.earlyoom.setup(mode);
  } catch (e) {
    r = { ok: false, reason: 'failed', message: `earlyoom non modifié : ${e instanceof Error ? e.message : String(e)}` };
  }
  if (r.ok) onToast(mode === 'install' ? 'earlyoom installé, configuré et actif' : 'earlyoom configuré et actif', 'info');
  else onToast(r.message, r.reason === 'cancelled' || r.reason === 'stale' ? 'info' : 'error');
  if (r.ok || r.reason === 'stale') window.dispatchEvent(new Event(EARLYOOM_CHANGED));
  return r;
}

/** « Protection anti-gel à mettre à jour » (confirmation native puis mot de passe dans le main), toast du résultat. */
export async function runEarlyoomUpgrade(onToast: ToastFn): Promise<ApplyResult> {
  let r: ApplyResult;
  try {
    r = await window.procWatch.earlyoom.upgrade();
  } catch (e) {
    r = { ok: false, reason: 'failed', message: `earlyoom non modifié : ${e instanceof Error ? e.message : String(e)}` };
  }
  if (r.ok) onToast('Protection anti-gel mise à jour : earlyoom redémarré', 'info');
  else onToast(r.message, r.reason === 'cancelled' || r.reason === 'stale' ? 'info' : 'error');
  if (r.ok || r.reason === 'stale') window.dispatchEvent(new Event(EARLYOOM_CHANGED));
  return r;
}

/** Installer, activer ou mettre à jour, selon ce que propose le pop-up. */
export const runEarlyoomAction = (kind: EarlyoomReminderKind, onToast: ToastFn): Promise<ApplyResult> =>
  kind === 'upgrade' ? runEarlyoomUpgrade(onToast) : runEarlyoomSetup(kind, onToast);

/** État du pop-up : lu une fois au lancement ; « Plus tard » et la pause de 7 jours sont tenus par le main. */
export function useEarlyoomReminder(o: { onState: (s: ConfigState) => void; onToast: ToastFn }) {
  const [mode, setMode] = useState<EarlyoomReminderKind | null>(null);
  const [upgrade, setUpgrade] = useState<EarlyoomUpgrade | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(o);
  latest.current = o;
  const show = useCallback((r: { mode: EarlyoomReminderKind | null; status: Parameters<typeof upgradeNeed>[0] } | null) => {
    setMode(r ? r.mode : null);
    setUpgrade(r?.mode === 'upgrade' ? upgradeNeed(r.status) : null);
  }, []);
  useEffect(() => {
    window.procWatch.earlyoom.reminder().then(show, () => {});
  }, [show]);
  const remindLater = useCallback((kind: 'later' | 'week') => {
    setMode(null);
    window.procWatch.earlyoom.remindLater(kind).then((s) => latest.current.onState(s), () => {});
  }, []);
  const setup = useCallback(async (m: EarlyoomReminderKind) => {
    setBusy(true);
    try {
      const r = await runEarlyoomAction(m, (msg, kind) => latest.current.onToast(msg, kind));
      const next = popupAfterSetup(r);
      if (next === 'close') setMode(null);
      else if (next === 'refresh') {
        // État changé (ex. installé entre-temps mais inactif) : le pop-up reste ouvert avec le nouveau mode.
        show(await window.procWatch.earlyoom.reminder().catch(() => null));
      }
    } finally {
      setBusy(false);
    }
  }, [show]);
  return { mode, upgrade, busy, remindLater, setup };
}

export function EarlyoomSetupPopup({ mode, upgrade, busy, onSetup, onLater }: {
  mode: EarlyoomReminderKind;
  /** Détail de la mise à niveau (mode `upgrade`). */
  upgrade?: EarlyoomUpgrade | null;
  busy: boolean;
  onSetup: (m: EarlyoomReminderKind) => void;
  onLater: (kind: 'later' | 'week') => void;
}) {
  const t = earlyoomPopupText(mode, upgrade);
  return (
    <motion.div
      className="alert-popup eo-setup-popup"
      data-testid="earlyoom-popup"
      role="alertdialog"
      aria-label={t.title}
      initial={{ opacity: 0, x: 40, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, transition: { duration: 0.18 } }}
      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
    >
      <span className="alert-popup-ico" aria-hidden>
        <ShieldAlert size={15} strokeWidth={2.2} />
      </span>
      <div className="alert-popup-main">
        <div className="alert-popup-head">
          <strong title={t.title}>{t.title}</strong>
        </div>
        <p>{t.body}</p>
        <div className="alert-popup-actions eo-setup-actions">
          <button className="alert-popup-go" data-testid="earlyoom-popup-setup" disabled={busy} onClick={() => onSetup(mode)}>
            <KeyRound size={12} strokeWidth={2.2} />
            {busy ? t.busy : t.primary}
          </button>
          <button data-testid="earlyoom-popup-later" disabled={busy} onClick={() => onLater('later')}>
            {t.later}
          </button>
          <button data-testid="earlyoom-popup-snooze" disabled={busy} onClick={() => onLater('week')}>
            {t.snooze}
          </button>
        </div>
      </div>
      <button className="alert-popup-x" aria-label="Fermer (rappel au prochain lancement)" title="Fermer" disabled={busy} onClick={() => onLater('later')}>
        <X size={13} strokeWidth={2.4} />
      </button>
    </motion.div>
  );
}
