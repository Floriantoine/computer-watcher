import { useCallback, useEffect, useRef, useState } from 'react';
import { Link2, Trash2, TriangleAlert } from 'lucide-react';
import { APP_DISPLAY_NAME } from '../../../core/appName';
import { displayName, type TmpListing } from '../../../core/tmpClean';
import { TMP_SCAN_LIMITS } from '../../../core/tmpScanLimits';
import { formatKB } from '../format';
import { createSingleFlight, quarantineMessage, sortTmpEntries, tmpCleanMessage, tmpSelection, type TmpSort } from '../tmpClean';
import { ipcErrorMessage } from '../viewModel';

/** État et actions de la liste /tmp (page /tmp) : partagés entre la liste et la tuile « Quarantaine ». */
export interface TmpClean {
  listing: TmpListing | null;
  error: string | null;
  selected: ReadonlySet<string>;
  /** Suppression ou vidage en cours : cases et boutons désactivés. */
  busy: boolean;
  /** Relit la liste (« Actualiser », après une suppression). */
  load: () => void;
  toggle: (name: string) => void;
  /** « Supprimer la sélection » : la seule confirmation est la boîte native du main. */
  run: () => Promise<void>;
  /** « Vider la quarantaine » : confirmation native du main. */
  emptyQuarantine: () => Promise<void>;
}

/**
 * Plus gros éléments de premier niveau de /tmp, à cocher pour les supprimer (B1 bis). `onChanged` : appelé après chaque
 * suppression ou vidage (la page relit l'occupation de /tmp).
 */
export function useTmpClean(onToast?: (message: string, kind: 'info' | 'error') => void, onChanged?: () => void): TmpClean {
  const [listing, setListing] = useState<TmpListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // un seul appel IPC à la fois, même pour un double clic dans la même image (busy n'est vu qu'au rendu suivant)
  const flight = useRef(createSingleFlight()).current;
  // seule la dernière lecture compte (« Actualiser » pendant une lecture, page quittée)
  const seq = useRef(0);
  useEffect(
    () => () => {
      seq.current++;
    },
    [],
  );

  const load = useCallback(() => {
    const mine = ++seq.current;
    setError(null);
    window.procWatch.tmp.entries().then(
      (l) => {
        if (mine !== seq.current) return;
        setListing(l);
        // une ligne devenue non supprimable n'est plus cochée
        setSelected((s) => new Set([...s].filter((n) => l.entries.some((e) => e.name === n && e.refusal === null))));
      },
      (e: unknown) => {
        if (mine !== seq.current) return;
        // plus rien d'une lecture précédente : ni lignes, ni sélection, ni bouton « Supprimer »
        setListing(null);
        setSelected(new Set());
        setError(ipcErrorMessage(e));
      },
    );
  }, []);
  useEffect(() => load(), [load]);

  const toggle = useCallback(
    (name: string) =>
      setSelected((s) => {
        const n = new Set(s);
        if (n.has(name)) n.delete(name);
        else n.add(name);
        return n;
      }),
    [],
  );

  const emptyQuarantine = async () => {
    await flight(async () => {
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
        onChanged?.();
      }
    });
  };

  // la seule confirmation est la boîte native du main (chemins exacts, total, « Annuler » par défaut)
  const run = async () => {
    const sel = tmpSelection(listing?.entries ?? [], selected);
    if (!sel.items.length) return;
    await flight(async () => {
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
        onChanged?.();
      }
    });
  };

  return { listing, error, selected, busy, load, toggle, run, emptyQuarantine };
}

/**
 * Liste de la page /tmp, triée par taille ou par nom. Une ligne non supprimable dit pourquoi ; le résumé de la sélection
 * est affiché ici, la confirmation est la boîte native du main, qui revérifie tout juste avant de supprimer. Suppression
 * définitive : la corbeille est sur disque, elle ne libérerait pas la RAM. Le bouton « Vider la quarantaine » est dans la
 * tuile Quarantaine ; la liste signale les quarantaines restées.
 */
export function TmpCleanList({ clean, sort }: { clean: TmpClean; sort: TmpSort }) {
  const { listing, error, selected, busy, toggle, run } = clean;
  const sel = tmpSelection(listing?.entries ?? [], selected);
  const uninspectableNames = [...new Set((listing?.uninspectable ?? []).map((p) => p.name))];
  const root = listing?.root ?? '/tmp';
  const atLeast = listing?.truncated ? 'au moins ' : '';


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
          {sortTmpEntries(listing.entries, sort).map((e) => {
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
            <TriangleAlert size={11} strokeWidth={2.2} aria-hidden /> {listing.quarantines.length > 1 ? `${listing.quarantines.length} quarantaines` : 'Une quarantaine'} de {APP_DISPLAY_NAME}
            {listing.quarantines.length > 1 ? ' restées' : ' restée'} (suppression interrompue) : {listing.quarantines.map((q) => displayName(q.name).text).join(', ')}
          </span>
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
            title={`${APP_DISPLAY_NAME} demande confirmation (chemins exacts, total), puis revérifie chaque élément juste avant de le supprimer`}
            onClick={() => void run()}
          >
            <Trash2 size={13} strokeWidth={2} /> {busy ? 'Suppression…' : sel.label}
          </button>
        </div>
      )}
    </div>
  );
}
