import { useCallback, useEffect, useState } from 'react';
import { Link2, Trash2, TriangleAlert } from 'lucide-react';
import { displayName, type TmpListing } from '../../../core/tmpClean';
import { TMP_SCAN_LIMITS } from '../../../core/tmpScanLimits';
import { formatKB } from '../format';
import { quarantineMessage, tmpCleanMessage, tmpSelection } from '../tmpClean';
import { ipcErrorMessage } from '../viewModel';

interface Props {
  onToast?: (message: string, kind: 'info' | 'error') => void;
}

/**
 * Plus gros éléments de premier niveau de /tmp, à cocher pour les supprimer (B1 bis). Une ligne non supprimable dit pourquoi ;
 * le résumé de la sélection est affiché ici, la confirmation est la boîte native du main, qui revérifie tout juste avant
 * de supprimer. Suppression définitive : la corbeille est sur disque, elle ne libérerait pas la RAM.
 */
export function TmpCleanList({ onToast }: Props) {
  const [listing, setListing] = useState<TmpListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    let alive = true;
    setError(null);
    window.procWatch.tmp.entries().then(
      (l) => {
        if (!alive) return;
        setListing(l);
        // une ligne devenue non supprimable n'est plus cochée
        setSelected((s) => new Set([...s].filter((n) => l.entries.some((e) => e.name === n && e.refusal === null))));
      },
      (e: unknown) => alive && setError(ipcErrorMessage(e)),
    );
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => load(), [load]);

  const sel = tmpSelection(listing?.entries ?? [], selected);
  const uninspectableNames = [...new Set((listing?.uninspectable ?? []).map((p) => p.name))];
  const root = listing?.root ?? '/tmp';
  const atLeast = listing?.truncated ? 'au moins ' : '';


  const toggle = (name: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  const emptyQuarantine = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const out = await window.procWatch.tmp.emptyQuarantine();
      if (out.results.length || out.cancelled) {
        const m = quarantineMessage(out);
        onToast?.(m.message, m.kind);
      }
    } catch (e) {
      onToast?.(ipcErrorMessage(e), 'error');
    } finally {
      setBusy(false);
      load();
    }
  };

  // la seule confirmation est la boîte native du main (chemins exacts, total, « Annuler » par défaut)
  const run = async () => {
    if (!sel.items.length || busy) return;
    setBusy(true);
    try {
      const out = await window.procWatch.tmp.delete(sel.items);
      const m = tmpCleanMessage(out);
      onToast?.(m.message, m.kind);
      setSelected(new Set());
    } catch (e) {
      onToast?.(ipcErrorMessage(e), 'error');
    } finally {
      setBusy(false);
      load();
    }
  };

  return (
    <div className="tmp-dirs tmp-clean" data-testid="tmp-clean">
      {root !== '/tmp' && <div className="sub partial" data-testid="tmp-clean-root">Racine de test : {root}</div>}
      {error ? (
        <div className="sub">Lecture de {root} impossible : {error}</div>
      ) : !listing ? (
        <div className="sub">Calcul…</div>
      ) : listing.entries.length === 0 ? (
        <div className="sub">Rien dans {root}</div>
      ) : (
        <ul aria-label={`Éléments de ${root}`}>
          {listing.entries.map((e) => {
            const id = `tmp-clean-${e.ino}`;
            const shown = displayName(e.name);
            const disabled = e.refusal !== null || busy;
            return (
              <li key={e.name} className={e.refusal ? 'refused' : undefined} data-testid="tmp-clean-row">
                <input
                  type="checkbox"
                  id={id}
                  checked={selected.has(e.name) && e.refusal === null}
                  disabled={disabled}
                  onChange={() => toggle(e.name)}
                  aria-describedby={e.refusal ? `${id}-why` : undefined}
                />
                <label htmlFor={id} className="mono path" title={`${root}/${shown.text}`}>
                  {e.kind === 'link' && <Link2 size={11} strokeWidth={2.2} aria-label="lien symbolique (seul le lien est supprimé)" />}
                  {shown.escaped && <TriangleAlert size={11} strokeWidth={2.2} className="warn" aria-label="nom avec caractères invisibles ou de contrôle (affichés échappés)" />}
                  {shown.text}
                </label>
                {e.cache && <span className="tmp-badge" title="Cache connu : se reconstruit tout seul">cache, se reconstruit tout seul</span>}
                {e.recent && e.refusal === null && (
                  <span className="tmp-recent" title="Modifié il y a moins de 5 min : peut-être en cours d'utilisation">
                    <TriangleAlert size={10} strokeWidth={2.4} aria-hidden /> modifié il y a moins de 5 min
                  </span>
                )}
                {e.refusal && <span className="tmp-why" id={`${id}-why`}>{e.refusal}</span>}
                <span className="mono size">{e.kind === 'dir' ? atLeast : ''}{formatKB(e.sizeKB)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {listing?.truncated && (
        <div className="sub partial">
          Parcours partiel (arrêté à {TMP_SCAN_LIMITS.maxEntries.toLocaleString('fr-FR')} entrées ou {TMP_SCAN_LIMITS.budgetMs / 1000} s) : tailles « au moins »
        </div>
      )}
      {listing && listing.uninspectable.length > 0 && (
        <div className="sub note" title={listing.uninspectable.map((p) => `${p.name} (pid ${p.pid})`).join(', ')}>
          {listing.uninspectable.length} processus à droits élevés non vérifiables ({uninspectableNames.slice(0, 4).join(', ')}) ; sockets des applications isolées (flatpak…) non vus
        </div>
      )}
      {listing?.disabled && <div className="sub partial" data-testid="tmp-clean-disabled">{listing.disabled}</div>}
      {listing && listing.quarantines.length > 0 && (
        <div className="tmp-clean-quarantine" data-testid="tmp-clean-quarantine">
          <span className="sub partial">
            <TriangleAlert size={11} strokeWidth={2.2} aria-hidden /> {listing.quarantines.length > 1 ? `${listing.quarantines.length} quarantaines` : 'Une quarantaine'} de proc-watch
            {listing.quarantines.length > 1 ? ' restées' : ' restée'} (suppression interrompue) : {listing.quarantines.map((q) => displayName(q.name).text).join(', ')}
          </span>
          {listing.quarantines.some((q) => q.eligible) && !listing.disabled && (
            <button className="danger sm" data-testid="tmp-clean-empty-quarantine" disabled={busy} onClick={() => void emptyQuarantine()}>
              <Trash2 size={13} strokeWidth={2} /> Vider la quarantaine
            </button>
          )}
        </div>
      )}
      {listing && !listing.disabled && sel.entries.length > 0 && (
        <div className="tmp-clean-summary" data-testid="tmp-clean-summary" aria-live="polite">
          <div className="sub">Sélection, supprimée définitivement (la corbeille ne libérerait pas la RAM) :</div>
          <ul>
            {sel.entries.map((e) => {
              const shown = displayName(e.name);
              return (
                <li key={e.name}>
                  <span className="mono path">
                    {shown.escaped && '⚠ '}
                    {shown.text}{e.kind === 'link' ? ' (le lien seul)' : e.kind === 'dir' ? '/' : ''}
                  </span>
                  {e.recent && <span className="tmp-recent">⚠ modifié il y a moins de 5 min</span>}
                  <span className="mono size">{e.kind === 'dir' ? atLeast : ''}{formatKB(e.sizeKB)}</span>
                </li>
              );
            })}
          </ul>
          <div className="sub">Total : {atLeast}{formatKB(sel.sizeKB)}</div>
          {uninspectableNames.length > 0 && (
            <div className="sub tmp-clean-uninspectable" data-testid="tmp-clean-uninspectable">
              <TriangleAlert size={11} strokeWidth={2.2} aria-hidden /> Non vérifiable : un fichier ouvert par {uninspectableNames.join(', ')} (droits élevés) ne serait pas détecté.
            </div>
          )}
        </div>
      )}
      {listing && !listing.disabled && listing.entries.some((e) => e.refusal === null) && (
        <div className="tmp-clean-actions">
          <button
            className="danger sm"
            data-testid="tmp-clean-delete"
            disabled={!sel.items.length || busy}
            title="proc-watch demande confirmation (chemins exacts, total), puis revérifie chaque élément juste avant de le supprimer"
            onClick={() => void run()}
          >
            <Trash2 size={13} strokeWidth={2} /> {busy ? 'Suppression…' : sel.label}
          </button>
        </div>
      )}
    </div>
  );
}
