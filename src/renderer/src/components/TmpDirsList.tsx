import { useEffect, useState } from 'react';
import type { TmpUsage } from '../../../core/types';
import { TMP_SCAN_LIMITS } from '../../../core/tmpScanLimits';
import { formatKB } from '../format';
import { ipcErrorMessage } from '../viewModel';

/**
 * Plus gros dossiers de /tmp à cet instant (calculés par le main à l'ouverture, en lecture seule). La suppression se fait
 * sur la page /tmp (`onOpenTmp`).
 */
export function TmpDirsList({ onOpenTmp }: { onOpenTmp?: () => void }) {
  const [usage, setUsage] = useState<TmpUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    window.procWatch.tmp.topDirs().then(
      (u) => alive && setUsage(u),
      (e: unknown) => alive && setError(ipcErrorMessage(e)),
    );
    return () => {
      alive = false;
    };
  }, []);
  const atLeast = usage?.truncated ? 'au moins ' : '';
  return (
    <div className="tmp-dirs" data-testid="tmp-dirs">
      {error ? (
        <div className="sub">Lecture de /tmp impossible : {error}</div>
      ) : !usage ? (
        <div className="sub">Calcul…</div>
      ) : (
        <>
          {usage.dirs.length === 0 ? (
            <div className="sub">Aucun dossier dans /tmp</div>
          ) : (
            <ul>
              {usage.dirs.map((d) => (
                <li key={d.path}>
                  <span className="mono path" title={d.path}>{d.path}</span>
                  <span className="mono size">{atLeast}{formatKB(d.sizeKB)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="sub">Fichiers à la racine : {atLeast}{formatKB(usage.rootFilesKB)}</div>
          {usage.truncated && (
            <div className="sub partial">
              Parcours partiel (arrêté à {TMP_SCAN_LIMITS.maxEntries.toLocaleString('fr-FR')} entrées ou {TMP_SCAN_LIMITS.budgetMs / 1000} s) : tailles « au moins », classement approximatif
            </div>
          )}
          {usage.skipped > 0 && (
            <div className="sub">{usage.skipped} dossier{usage.skipped > 1 ? 's' : ''} illisible{usage.skipped > 1 ? 's' : ''} ignoré{usage.skipped > 1 ? 's' : ''}</div>
          )}
        </>
      )}
      <div className="sub note">
        État actuel de /tmp, en lecture seule ici
        {onOpenTmp && (
          <>
            {' '}·{' '}
            <button type="button" className="link tmp-dirs-open" data-testid="tmp-dirs-open-page" title="Ouvrir la page /tmp (suppression)" onClick={onOpenTmp}>
              Gérer sur la page /tmp
            </button>
          </>
        )}
      </div>
    </div>
  );
}
