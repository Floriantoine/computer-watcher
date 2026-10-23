import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, Trash2 } from 'lucide-react';
import type { DeskRootStatus } from '../../../core/antigel/deskRoot';
import { DESK_ROOT_CHANGED, deskRootSummary, deskRootToast } from '../deskRootView';
import { Row } from './settingsUi';
import '../deskRoot.css';

/** État de la protection mémoire système (lecture seule dans le main), relu au montage, après une action et toutes les 60 s. */
export function useDeskRoot(): DeskRootStatus | null {
  const [st, setSt] = useState<DeskRootStatus | null>(null);
  const load = useCallback(() => {
    window.procWatch.deskRoot?.status().then(setSt, () => {});
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    window.addEventListener(DESK_ROOT_CHANGED, load);
    return () => {
      clearInterval(t);
      window.removeEventListener(DESK_ROOT_CHANGED, load);
    };
  }, [load]);
  return st;
}

/** Lance l'action (confirmation et pkexec dans le main), puis prévient les autres vues. */
function useDeskRootAction(): { busy: boolean; message: { text: string; error: boolean } | null; run: (mode: 'install' | 'remove') => Promise<void> } {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const run = async (mode: 'install' | 'remove') => {
    setBusy(true);
    try {
      const t = deskRootToast(await window.procWatch.deskRoot.apply(mode));
      setMessage({ text: t.message, error: t.kind === 'error' });
    } catch (e) {
      setMessage({ text: `Rien n’est modifié : ${e instanceof Error ? e.message : String(e)}`, error: true });
    } finally {
      setBusy(false);
      window.dispatchEvent(new Event(DESK_ROOT_CHANGED));
    }
  };
  return { busy, message, run };
}

const label = (a: 'install' | 'update') => (a === 'install' ? 'Activer' : 'Mettre à jour');

/** Réglages → Plafond de travail, sous « Bureau prioritaire » : état, « Activer » / « Mettre à jour », « Retirer ». */
export function DeskRootRow({ disabled }: { disabled?: boolean }) {
  const st = useDeskRoot();
  const { busy, message, run } = useDeskRootAction();
  if (!st) return null;
  const s = deskRootSummary(st);
  // état et message sous la ligne, sur toute la largeur ; boutons seuls à droite du libellé
  return (
    <Row label="Protection mémoire système"
      help="Le noyau ne protège la mémoire d’un groupe de processus que si chaque niveau au-dessus l’est aussi ; les niveaux système de la session (user.slice, user-<uid>.slice, user@<uid>.service) ne le sont pas par défaut. « Activer » y pose la réserve du bureau (MemoryLow) par trois petits fichiers dans /etc/systemd/system, avec le mot de passe administrateur ; « Retirer » les supprime."
      note={
        <div className="desk-root" data-testid="desk-root">
          <p className={`sub desk-root-summary tone-${s.tone}`} data-testid="desk-root-summary">{s.text}</p>
          {message && <p className={message.error ? 'field-error' : 'sub'} data-testid="desk-root-message">{message.text}</p>}
        </div>
      }>
      {() => (
        <span className="desk-root-actions">
          {s.action && (
            <button type="button" className="primary" data-testid="desk-root-apply" disabled={busy || disabled} onClick={() => run('install')}>
              <ShieldCheck size={13} strokeWidth={2} /> {label(s.action)}
            </button>
          )}
          {s.canRemove && (
            <button type="button" data-testid="desk-root-remove" disabled={busy} onClick={() => run('remove')}>
              <Trash2 size={13} strokeWidth={2} /> Retirer
            </button>
          )}
        </span>
      )}
    </Row>
  );
}

/** Carte Métriques : bouton à côté de la ligne du bureau prioritaire quand la protection système manque ou est périmée. */
export function DeskRootCardAction({ st }: { st: DeskRootStatus | null }) {
  const { busy, message, run } = useDeskRootAction();
  const s = st ? deskRootSummary(st) : null;
  if (!s?.action && !message) return null;
  return (
    <p className="sub desk-root-card">
      {s?.action && (
        <button type="button" data-testid="antigel-desk-root-apply" disabled={busy} onClick={() => run('install')}>
          <ShieldCheck size={13} strokeWidth={2} /> {label(s.action)}
        </button>
      )}
      {message && <span className={message.error ? 'field-error' : undefined} data-testid="antigel-desk-root-message"> {message.text}</span>}
    </p>
  );
}
