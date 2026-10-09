// Pop-up « Mise à jour X.Y.Z disponible » (même style que les pop-ups d'alerte) et section Réglages › À propos.
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Download, ExternalLink, Info, RefreshCw, RotateCw, X } from 'lucide-react';
import type { UpdateView } from '../../../core/update';
import { aboutLines, updatePopupText, type UpdateAction } from '../updatePopup';
import { Card, Row, Switch } from './settingsUi';
import '../update.css';

type ToastFn = (m: string, kind?: 'error' | 'info') => void;

/** Vue des mises à jour tenue par le main (poussée à chaque changement). */
export function useUpdateView(): [UpdateView | null, (v: UpdateView) => void] {
  const [view, setView] = useState<UpdateView | null>(null);
  useEffect(() => {
    let alive = true;
    window.procWatch.update.get().then((v) => alive && setView(v), () => {});
    const off = window.procWatch.update.onView(setView);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return [view, setView];
}

/** Action d'un bouton du pop-up → IPC ; la nouvelle vue arrive par onView (ou la réponse). */
export function useUpdateActions(setView: (v: UpdateView) => void, onToast: ToastFn) {
  // Fonction stable (le pop-up reste mémoïsé entre deux snapshots), toast le plus récent.
  const toast = useRef(onToast);
  toast.current = onToast;
  return useCallback(
    (a: UpdateAction['kind'], url?: string) => {
      const fail = (e: unknown) => toast.current(`Mise à jour : ${e instanceof Error ? e.message : String(e)}`);
      const u = window.procWatch.update;
      if (a === 'download') u.download().then(setView, fail);
      else if (a === 'install') u.install().catch(fail);
      else if (a === 'later') u.later().then(setView, fail);
      else if (a === 'ignore') u.ignore().then(setView, fail);
      else if (a === 'open' && url) u.openRelease(url).catch(fail);
    },
    [setView],
  );
}

const ICON: Partial<Record<UpdateAction['kind'], typeof Download>> = { download: Download, install: RotateCw, open: ExternalLink };

export function UpdatePopup({ view, onAction }: { view: UpdateView; onAction: (a: UpdateAction['kind'], url?: string) => void }) {
  const t = updatePopupText(view);
  const url = view.state.available?.url;
  const closable = view.state.phase !== 'downloading';
  return (
    <motion.div
      className="alert-popup upd-popup"
      data-testid="update-popup"
      role="alertdialog"
      aria-label={t.title}
      initial={{ opacity: 0, x: 40, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, transition: { duration: 0.18 } }}
      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
    >
      <span className="alert-popup-ico" aria-hidden>
        <Download size={15} strokeWidth={2.2} />
      </span>
      <div className="alert-popup-main">
        <div className="alert-popup-head">
          <strong title={t.title}>{t.title}</strong>
        </div>
        <p data-testid="update-popup-body">{t.body}</p>
        {t.progress !== null && (
          <div className="upd-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(t.progress)}>
            <span style={{ width: `${t.progress}%` }} />
          </div>
        )}
        {t.actions.length > 0 && (
          <div className="alert-popup-actions upd-actions">
            {t.actions.map((a, i) => {
              const Icon = ICON[a.kind];
              return (
                <button key={a.kind} className={i === 0 ? 'alert-popup-go' : undefined} data-testid={`update-popup-${a.kind}`} onClick={() => onAction(a.kind, url)}>
                  {Icon && <Icon size={12} strokeWidth={2.2} />}
                  {a.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {closable && (
        <button className="alert-popup-x" aria-label="Plus tard" title="Plus tard" onClick={() => onAction('later')}>
          <X size={13} strokeWidth={2.4} />
        </button>
      )}
    </motion.div>
  );
}

const fmtTime = (ms: number) => new Date(ms).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

/** Réglages › À propos : version, vérification automatique, dernière vérification, « Vérifier maintenant ». */
export function AboutPanel({ onToast }: { onToast: ToastFn }) {
  const [view, setView] = useUpdateView();
  const [busy, setBusy] = useState(false);
  if (!view) return null;
  const { state, prefs } = view;
  const lines = aboutLines(state, fmtTime);
  const setPrefs = (p: { enabled?: boolean; prerelease?: boolean }) =>
    window.procWatch.update.setPrefs(p).then(setView, (e: unknown) => onToast(`Réglage non enregistré : ${e instanceof Error ? e.message : String(e)}`));
  const checkNow = () => {
    setBusy(true);
    window.procWatch.update
      .check()
      .then((v) => {
        setView(v);
        if (v.state.lastResult === 'none') onToast('proc-watch est à jour', 'info');
      }, (e: unknown) => onToast(`Vérification impossible : ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setBusy(false));
  };
  const off = state.mode === 'off';
  return (
    <Card title="Version et mises à jour" icon={<Info size={14} strokeWidth={2} />} testid="about-card">
      <p className="upd-version">
        proc-watch <span className="mono" data-testid="about-version">{state.current}</span>
      </p>
      <p className="hint upd-line">{lines.mode}</p>
      <Row label="Vérifier les mises à jour" help="Au démarrage (après 30 s) puis toutes les 6 h. Rien n’est téléchargé sans ton accord.">
        {(id) => <Switch id={id} checked={prefs.enabled} label="Vérifier les mises à jour" disabled={off} onToggle={() => void setPrefs({ enabled: !prefs.enabled })} />}
      </Row>
      <Row label="Inclure les préversions" help="Versions de test (bêta, rc) : moins stables.">
        {(id) => <Switch id={id} checked={prefs.prerelease} label="Inclure les préversions" disabled={off} onToggle={() => void setPrefs({ prerelease: !prefs.prerelease })} />}
      </Row>
      <div className="s-danger-row">
        <p className="hint" style={{ margin: 0 }} data-testid="about-last-check">
          {lines.last}
          {prefs.ignoredVersion && ` · version ${prefs.ignoredVersion} ignorée`}
        </p>
        <button className="primary upd-check" data-testid="about-check-now" disabled={off || busy || state.phase === 'downloading'} onClick={checkNow}>
          <RefreshCw size={12} strokeWidth={2.2} />
          {busy ? 'Vérification…' : 'Vérifier maintenant'}
        </button>
      </div>
    </Card>
  );
}
