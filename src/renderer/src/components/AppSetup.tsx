// Réglages : « Démarrer avec la session » (Affichage) et À propos (version, accueil, désinstallation).
import { useEffect, useState } from 'react';
import { Info, RotateCcw, Trash2, TriangleAlert } from 'lucide-react';
import type { AboutInfo, AutostartInfo, UninstallItem, UninstallOptions } from '../../../core/onboarding';
import { uninstallReport, type ResultText } from '../onboardingText';
import { ipcErrorMessage } from '../viewModel';
import { Card, Row, Switch } from './settingsUi';
import '../onboarding.css';

type ToastFn = (m: string, kind?: 'error' | 'info') => void;

export function AutostartRow({ onToast }: { onToast: ToastFn }) {
  const [a, setA] = useState<AutostartInfo | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    window.procWatch.autostart.get().then(setA, () => {});
  }, []);
  const toggle = async () => {
    if (!a || busy) return;
    setBusy(true);
    try {
      const next = await window.procWatch.autostart.set(!a.enabled);
      setA(next);
      onToast(next.enabled ? `Démarrage avec la session activé : ${next.path}` : `Démarrage avec la session désactivé : ${next.path} retiré`, 'info');
    } catch (e) {
      onToast(`Démarrage avec la session non modifié : ${ipcErrorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row
      label="Démarrer avec la session"
      help={a?.target === null ? 'Disponible uniquement dans la version installée (AppImage ou .deb).' : 'Caché dans la barre des tâches à l’ouverture de session (fenêtre réduite sans zone de notification).'}
    >
      {(id) => (
        <span data-testid="autostart">
          <Switch id={id} checked={!!a?.enabled} label="Démarrer avec la session" disabled={!a || busy || (a.target === null && !a.enabled)} onToggle={() => void toggle()} />
        </span>
      )}
    </Row>
  );
}

export function AboutSetup({ onToast, onReopenOnboarding }: { onToast: ToastFn; onReopenOnboarding: () => void }) {
  const [info, setInfo] = useState<AboutInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<UninstallOptions>({ history: false, config: false });
  const [plan, setPlan] = useState<UninstallItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ResultText | null>(null);
  useEffect(() => {
    window.procWatch.about.info().then(setInfo, () => {});
  }, []);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    window.procWatch.uninstall.plan(opts).then(
      (p) => alive && setPlan(p.items),
      () => alive && setPlan(null),
    );
    return () => {
      alive = false;
    };
  }, [open, opts]);

  const uninstall = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await window.procWatch.uninstall.run(opts);
      if (r.cancelled) return;
      setReport(uninstallReport(r.result));
      window.procWatch.uninstall.plan(opts).then((p) => setPlan(p.items), () => {});
    } catch (e) {
      onToast(`Désinstallation impossible : ${ipcErrorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="about-setup">
      <Card title="Installation" icon={<Info size={14} strokeWidth={2} />} testid="about-install">
        <div className="about-row">
          <span className="hint" style={{ margin: 0 }}>
            {!info ? '' : info.installedCopy ? <>Installée : <code>{info.installedCopy}</code></> : info.appImage ? 'AppImage non installée' : info.packaged ? 'Paquet .deb' : 'Version de développement'}
          </span>
        </div>
        <div className="about-row">
          <p className="hint" style={{ margin: 0 }}>Installer comme une app, démarrage avec la session, historique et earlyoom.</p>
          <button data-testid="about-reopen-onboarding" onClick={onReopenOnboarding}>
            <RotateCcw size={13} strokeWidth={2} /> Relancer l’accueil
          </button>
        </div>
      </Card>

      <Card title="Désinstaller" icon={<TriangleAlert size={14} strokeWidth={2} />} danger testid="about-uninstall">
        <div className="about-row">
          <p className="hint" style={{ margin: 0 }}>
            Retire l’entrée de menu, l’icône, le démarrage automatique, le service d’enregistrement et la copie installée, puis quitte. earlyoom
            n’est jamais modifié.
          </p>
          {!open && (
            <button className="danger" data-testid="about-uninstall-open" onClick={() => setOpen(true)}>
              <Trash2 size={13} strokeWidth={2} /> Désinstaller proc-watch…
            </button>
          )}
        </div>
        {open && (
          <>
            <div className="about-opts">
              <label className="onb-check">
                <input type="checkbox" checked={opts.history} onChange={(e) => setOpts({ ...opts, history: e.target.checked })} data-testid="uninstall-history" />
                <span>Supprimer aussi l’historique (base des métriques et événements)</span>
              </label>
              <label className="onb-check">
                <input type="checkbox" checked={opts.config} onChange={(e) => setOpts({ ...opts, config: e.target.checked })} data-testid="uninstall-config" />
                <span>Supprimer aussi la configuration (réglages, protégés, règles)</span>
              </label>
            </div>
            <p className="hint" style={{ margin: '8px 0 0' }}>Sera retiré (une confirmation reprend cette liste) :</p>
            <ul className="about-plan" data-testid="uninstall-plan">
              {plan === null ? <li>…</li> : plan.length === 0 ? <li>Aucun fichier de proc-watch trouvé.</li> : plan.map((i) => (
                <li key={i.path}>{i.label}{i.dir ? ' (dossier, s’il est vide)' : ''} : <code>{i.path}</code></li>
              ))}
            </ul>
            <div className="s-foot">
              <button onClick={() => setOpen(false)} disabled={busy}>Annuler</button>
              <button className="danger" data-testid="uninstall-run" disabled={busy} onClick={() => void uninstall()}>
                {busy ? 'Désinstallation…' : 'Désinstaller…'}
              </button>
            </div>
            {report && (
              <div className={`onb-result ${report.tone}`} role="status" data-testid="uninstall-report">
                <div>{report.lines.map((l) => <p key={l}>{l}</p>)}</div>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
