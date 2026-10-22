import { useCallback, useEffect, useRef, useState } from 'react';
import { BrushCleaning, Recycle } from 'lucide-react';
import { cachesOffer, cachesOutcomeMessage, JEST_CACHE_ADVICE, type TmpCacheId, type TmpCaches } from '../../../core/tmpCaches';
import { cacheRows, emptyAllAction, showJestAdvice } from '../tmpCaches';
import { createSingleFlight } from '../tmpClean';
import { ipcErrorMessage } from '../viewModel';

/** Ce qu'un vidage risque au pire, dit sur chaque bouton « Vider ». */
const EMPTY_TITLE = 'Supprime les fichiers du cache et garde ses dossiers, sans confirmation : l’outil reconstruit son cache. Un test qui tourne continue ; au pire, un fichier de test qui lisait son cache à cet instant échoue une fois.';

/**
 * Caches connus de /tmp (Jest, Node.js…) : lecture, puis « Vider » en un clic (aucune confirmation : rien ne se perd).
 * Partagé par la section de la page /tmp et le bouton du pop-up d'alerte tmpfs. `reloadKey` : relit à chaque changement.
 */
export function useTmpCaches(onToast?: (message: string, kind: 'info' | 'error') => void, onChanged?: () => void, reloadKey = 0) {
  const [caches, setCaches] = useState<TmpCaches | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Caches en cours de vidage (null : aucun). */
  const [busy, setBusy] = useState<readonly TmpCacheId[] | null>(null);
  const flight = useRef(createSingleFlight()).current;
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
    window.procWatch.tmp.caches().then(
      (c) => mine === seq.current && setCaches(c),
      (e: unknown) => {
        if (mine !== seq.current) return;
        setCaches(null);
        setError(ipcErrorMessage(e));
      },
    );
  }, []);
  useEffect(() => load(), [load, reloadKey]);
  const empty = async (ids: TmpCacheId[]) => {
    await flight(async () => {
      setBusy(ids);
      try {
        const m = cachesOutcomeMessage(await window.procWatch.tmp.emptyCaches(ids));
        onToast?.(m.message, m.kind);
      } catch (e) {
        onToast?.(ipcErrorMessage(e), 'error');
      } finally {
        setBusy(null);
        load();
        onChanged?.();
      }
    });
  };
  return { caches, error, busy, load, empty };
}

export type TmpCachesState = ReturnType<typeof useTmpCaches>;

/** Section « Caches connus » de la page /tmp : chaque cache présent, sa taille et « Vider » ; « Tout vider » ; conseil Jest. */
export function TmpCachesPanel({ state, disabled = false }: { state: Pick<TmpCachesState, 'caches' | 'error' | 'busy' | 'empty'>; disabled?: boolean }) {
  const { caches, error, busy, empty } = state;
  const rows = cacheRows(caches);
  const all = emptyAllAction(caches);
  const off = disabled || busy !== null;
  return (
    <section className="chart-panel tmp-caches" data-testid="tmp-caches">
      <div className="chart-panel-head">
        <h3>
          <Recycle size={14} strokeWidth={2} /> Caches connus
        </h3>
        <span className="spacer" />
        {all && (
          <button className="sm" data-testid="tmp-caches-empty-all" disabled={off} title={EMPTY_TITLE} onClick={() => void empty(all.ids)}>
            <BrushCleaning size={13} strokeWidth={2} /> {busy && busy.length > 1 ? 'Vidage…' : all.label}
          </button>
        )}
      </div>
      <div className="sub">Ils se reconstruisent tout seuls. « Vider » supprime leurs fichiers et garde leurs dossiers : sans danger, même pendant un test.</div>
      {error ? (
        <div className="sub">Lecture impossible : {error}</div>
      ) : !caches ? (
        <div className="sub">Calcul…</div>
      ) : !rows.length ? (
        <div className="sub" data-testid="tmp-caches-none">Aucun cache connu dans {caches.root}</div>
      ) : (
        <ul aria-label="Caches connus">
          {rows.map((r) => (
            <li key={r.id} className={r.refusal ? 'refused' : undefined} data-testid="tmp-cache-row">
              <span className="tmp-cache-label">{r.label}</span>
              <span className="mono path" title={`${caches.root}/${r.name}`}>
                {r.name}
              </span>
              {r.refusal && <span className="tmp-why">{r.refusal}</span>}
              <span className="mono size">{r.size}</span>
              {r.canEmpty && (
                <button className="sm" data-testid={`tmp-cache-empty-${r.id}`} disabled={off} title={EMPTY_TITLE} onClick={() => void empty([r.id])}>
                  <BrushCleaning size={12} strokeWidth={2} /> {busy?.includes(r.id) ? 'Vidage…' : 'Vider'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {showJestAdvice(caches) && (
        <div className="sub note" data-testid="tmp-caches-advice">
          {JEST_CACHE_ADVICE}
        </div>
      )}
    </section>
  );
}

/** Bouton « Vider les caches (X) » du pop-up d'alerte tmpfs : seulement si les caches vidables font au moins 100 Mo. */
export function TmpCachesOfferButton({ state }: { state: Pick<TmpCachesState, 'caches' | 'busy' | 'empty'> }) {
  const offer = cachesOffer(state.caches);
  if (!offer) return null;
  return (
    <button className="alert-popup-caches" data-testid="alert-popup-empty-caches" disabled={state.busy !== null} title={EMPTY_TITLE} onClick={() => void state.empty(offer.ids)}>
      <BrushCleaning size={12} strokeWidth={2} /> {state.busy ? 'Vidage…' : offer.label}
    </button>
  );
}

/** Le même, avec sa lecture des caches (à l'apparition du pop-up, puis après le vidage : le bouton disparaît). */
export function TmpfsAlertCachesButton({ onToast }: { onToast?: (message: string, kind: 'info' | 'error') => void }) {
  return <TmpCachesOfferButton state={useTmpCaches(onToast)} />;
}
