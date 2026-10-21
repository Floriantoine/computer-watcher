import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Download, Rocket, Trash2 } from 'lucide-react';
import type { WrapAction, WrapItemStatus, WrapSetupStatus, WrapTarget } from '../../../core/wrapSetup';
import {
  applyToast, canInstallAll, previewLabel, stateBadge, summaryLine, WRAP_LIMITS, WRAP_ROLE, WRAP_TITLE, WRAP_WHY, wrapItemTitle,
} from '../wrapSetupView';
import { Card } from './settingsUi';
import '../wrapSetup.css';

type ToastFn = (m: string, kind?: 'error' | 'info') => void;

/** Diffusé après une installation ou un retrait (le rappel du lancement se ferme si tout est en place). */
export const WRAP_SETUP_CHANGED = 'pw:wrap-setup-changed';

/** Réglages → Plafond de travail : les trois éléments, leur état, ce qui sera ajouté, « Installer » / « Retirer ». */
export function WrapSetupCard({ onToast }: { onToast: ToastFn }) {
  const [status, setStatus] = useState<WrapSetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    window.procWatch.wrapSetup.status().then(
      (s) => {
        setStatus(s);
        setError(null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, []);
  useEffect(load, [load]);
  const run = async (action: WrapAction, part: WrapTarget) => {
    setBusy(true);
    try {
      const r = await window.procWatch.wrapSetup.apply(action, part);
      const t = applyToast(r, action);
      if (t) onToast(t.message, t.kind);
      if (!r.cancelled) {
        setStatus(r.status);
        window.dispatchEvent(new Event(WRAP_SETUP_CHANGED));
      }
    } catch (e) {
      onToast(`Rien n’est modifié : ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={WRAP_TITLE} icon={<Rocket size={14} strokeWidth={2} />} testid="wrap-setup" className="wrap-setup">
      <p className="sub wrap-why">{WRAP_WHY}</p>
      {error && <p className="field-error">{error}</p>}
      {status && (
        <>
          <div className="wrap-head">
            <p className={`wrap-summary${status.complete ? ' is-ok' : ''}`} data-testid="wrap-setup-summary">{summaryLine(status)}</p>
            <button type="button" className="primary" data-testid="wrap-setup-all" disabled={busy || !canInstallAll(status)} onClick={() => run('install', 'all')}>
              <Download size={13} strokeWidth={2} /> Tout installer
            </button>
          </div>
          <ul className="wrap-items">
            {status.items.map((i) => (
              <WrapItem key={i.part} item={i} busy={busy} onAction={(a) => run(a, i.part)} />
            ))}
          </ul>
        </>
      )}
      <div className="wrap-limits">
        <strong>Limites</strong>
        <ul>
          {WRAP_LIMITS.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <p className="sub">Chaque fichier modifié est d’abord sauvegardé à côté de lui (<span className="mono">….computer-watcher-AAAAMMJJ-HHMMSS.bak</span>). L’installation manuelle reste décrite dans le README.</p>
      </div>
    </Card>
  );
}

function WrapItem({ item, busy, onAction }: { item: WrapItemStatus; busy: boolean; onAction: (a: WrapAction) => void }) {
  const b = stateBadge(item);
  return (
    <li className="wrap-item" data-testid="wrap-setup-item" data-part={item.part} data-state={item.state}>
      <div className="wrap-item-head">
        <strong>{wrapItemTitle(item)}</strong>
        <span className={`wrap-badge tone-${b.tone}`} data-testid="wrap-setup-badge">{b.text}</span>
        <span className="wrap-actions">
          {item.canInstall && (
            <button type="button" data-testid="wrap-setup-install" disabled={busy} onClick={() => onAction('install')}>
              <Download size={13} strokeWidth={2} /> Installer
            </button>
          )}
          {item.canRemove && (
            <button type="button" className="danger" data-testid="wrap-setup-remove" disabled={busy} onClick={() => onAction('remove')}>
              <Trash2 size={13} strokeWidth={2} /> Retirer
            </button>
          )}
        </span>
      </div>
      <p className="sub">{WRAP_ROLE[item.part]}</p>
      <p className="wrap-detail" title={item.path}>{item.detail}</p>
      {item.preview && (item.canInstall || item.state === 'ours') && (
        <div className="wrap-preview">
          <span className="sub">{previewLabel(item)}</span>
          <pre data-testid="wrap-setup-preview">{item.preview}</pre>
        </div>
      )}
      {item.blocked && (
        <p className="wrap-note is-blocked" data-testid="wrap-setup-blocked">
          <AlertTriangle size={12} strokeWidth={2.2} /> {item.blocked}
        </p>
      )}
      {item.warnings.map((w) => (
        <p key={w} className="wrap-note" data-testid="wrap-setup-warning">
          <AlertTriangle size={12} strokeWidth={2.2} /> {w}
        </p>
      ))}
    </li>
  );
}
