import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence } from 'motion/react';
import { Link2, Trash2 } from 'lucide-react';
import type { TmpListing } from '../../../core/tmpClean';
import { TMP_SCAN_LIMITS } from '../../../core/tmpScanLimits';
import { formatKB } from '../format';
import { tmpCleanMessage, tmpSelection } from '../tmpClean';
import { ipcErrorMessage } from '../viewModel';
import { SettingsConfirm } from './SettingsConfirm';

interface Props {
  onToast?: (message: string, kind: 'info' | 'error') => void;
}

/**
 * Plus gros éléments de premier niveau de /tmp, à cocher pour les supprimer (B1 bis). Une ligne non supprimable dit pourquoi ;
 * le main revérifie tout juste avant de supprimer. Suppression définitive : la corbeille est sur disque, elle ne libérerait pas la RAM.
 */
export function TmpCleanList({ onToast }: Props) {
  const [listing, setListing] = useState<TmpListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
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
  const root = listing?.root ?? '/tmp';
  const atLeast = listing?.truncated ? 'au moins ' : '';

  useEffect(() => {
    if (!confirming) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfirming(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [confirming]);

  const toggle = (name: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  const run = async () => {
    setConfirming(false);
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
            const id = `tmp-clean-${e.name}`;
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
                <label htmlFor={id} className="mono path" title={`${root}/${e.name}`}>
                  {e.kind === 'link' && <Link2 size={11} strokeWidth={2.2} aria-label="lien symbolique (seul le lien est supprimé)" />}
                  {e.name}
                </label>
                {e.cache && <span className="tmp-badge" title="Cache connu : se reconstruit tout seul">cache, se reconstruit tout seul</span>}
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
          {listing.uninspectable.length} processus à droits élevés non vérifiables ({[...new Set(listing.uninspectable.map((p) => p.name))].slice(0, 4).join(', ')})
        </div>
      )}
      {listing && listing.entries.some((e) => e.refusal === null) && (
        <div className="tmp-clean-actions">
          <button className="danger sm" data-testid="tmp-clean-delete" disabled={!sel.items.length || busy} onClick={() => setConfirming(true)}>
            <Trash2 size={13} strokeWidth={2} /> {busy ? 'Suppression…' : sel.label}
          </button>
        </div>
      )}
      {createPortal(
        <AnimatePresence>
          {confirming && (
            <SettingsConfirm
              id="tmp-clean-confirm-title"
              title={`Supprimer définitivement ${sel.entries.length > 1 ? `ces ${sel.entries.length} éléments` : 'cet élément'} de ${root} ?`}
              text="C'est définitif, la corbeille ne libérerait pas la RAM (elle est sur disque). Chaque élément est revérifié juste avant d'être supprimé."
              confirmLabel={`Supprimer (${formatKB(sel.sizeKB)})`}
              focusCancel
              onCancel={() => setConfirming(false)}
              onConfirm={() => void run()}
            >
              <div className="prot-list tmp-clean-recap" data-testid="tmp-clean-recap">
                {sel.entries.map((e) => (
                  <div key={e.name} className="tmp-clean-recap-row">
                    <span className="mono">{root}/{e.name}{e.kind === 'link' ? ' (le lien seul)' : e.kind === 'dir' ? '/' : ''}</span>
                    <span className="mono size">{e.kind === 'dir' ? atLeast : ''}{formatKB(e.sizeKB)}</span>
                  </div>
                ))}
              </div>
            </SettingsConfirm>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
