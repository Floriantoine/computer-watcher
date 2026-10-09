import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDownWideNarrow, ArrowDownAZ, FolderOpen, RefreshCw, Trash2 } from 'lucide-react';
import type { TmpFsStats } from '../../../core/types';
import { DEFAULT_TMP_SORT, tmpTiles, type TmpSort, type TmpTile } from '../tmpClean';
import { ipcErrorMessage } from '../viewModel';
import { TmpCleanList, useTmpClean } from './TmpCleanList';

interface Props {
  /** Toast après une suppression ou un vidage de la quarantaine. */
  onToast?: (message: string, kind: 'info' | 'error') => void;
}

function Tile({ label, tile, extra, children }: { label: string; tile: TmpTile; extra?: string; children?: ReactNode }) {
  return (
    <div className={`tile${tile.error ? ' tile-error' : ''}`} data-testid="tmp-tile">
      <small>{label}</small>
      <b>{tile.value}</b>
      {tile.sub && (
        <span className="tile-sub" data-testid={tile.error ? 'tmp-tile-error' : undefined} role={tile.error ? 'alert' : undefined}>
          {tile.sub}
        </span>
      )}
      {extra && (
        <span className="tile-sub tile-extra" data-testid="tmp-tile-extra" title="Dossiers .proc-watch-trash-* que proc-watch ne peut pas vider (pas à vous ou droits inattendus)">
          {extra}
        </span>
      )}
      {children}
    </div>
  );
}

/** Tuiles du haut de la page /tmp : Occupé, Part de la RAM, Quarantaine (avec « Vider la quarantaine » si possible). */
export function TmpTiles({ tiles, busy, onEmptyQuarantine }: { tiles: ReturnType<typeof tmpTiles>; busy: boolean; onEmptyQuarantine: () => void }) {
  return (
    <div className="summary tmp-tiles" data-testid="tmp-tiles">
      <Tile label="Occupé" tile={tiles.used} />
      <Tile label="Part de la RAM" tile={tiles.ram} />
      <Tile label="Quarantaine" tile={tiles.quarantine} extra={tiles.quarantine.extra}>
        {tiles.quarantine.canEmpty && (
          <button className="danger sm tile-action" data-testid="tmp-clean-empty-quarantine" disabled={busy} onClick={onEmptyQuarantine}>
            <Trash2 size={12} strokeWidth={2} /> Vider la quarantaine
          </button>
        )}
      </Tile>
    </div>
  );
}

const SORTS: { id: TmpSort; label: string; icon: typeof ArrowDownAZ }[] = [
  { id: 'size', label: 'Taille', icon: ArrowDownWideNarrow },
  { id: 'name', label: 'Nom', icon: ArrowDownAZ },
];

/**
 * Page /tmp (onglet du haut) : occupation (statfs) et part de la RAM, quarantaines restées, puis les éléments de premier
 * niveau à cocher pour les supprimer (même liste et mêmes vérifications qu'avant). Tout est relu à l'ouverture et à
 * « Actualiser » ; l'occupation est relue après chaque suppression.
 */
export function TmpPage({ onToast }: Props) {
  const [stats, setStats] = useState<TmpFsStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [sort, setSort] = useState<TmpSort>(DEFAULT_TMP_SORT);
  const seq = useRef(0);
  useEffect(
    () => () => {
      seq.current++;
    },
    [],
  );
  const loadStats = useCallback(() => {
    const mine = ++seq.current;
    setStatsError(null);
    window.procWatch.tmp.stats().then(
      (s) => mine === seq.current && setStats(s),
      (e: unknown) => {
        if (mine !== seq.current) return;
        setStats(null);
        setStatsError(ipcErrorMessage(e));
      },
    );
  }, []);
  useEffect(() => loadStats(), [loadStats]);
  const clean = useTmpClean(onToast, loadStats);
  const tiles = tmpTiles({ stats, statsError, listing: clean.listing, listingError: clean.error });
  const root = clean.listing?.root ?? stats?.root ?? '/tmp';

  return (
    <div className="tmp-page" data-testid="tmp-page">
      <div className="page-head">
        <h2>
          <FolderOpen size={18} strokeWidth={2} />
          <span className="label">{root}</span>
        </h2>
        <span className="sub">
          {stats && !stats.inRam ? 'Système de fichiers sur disque' : 'Fichiers en mémoire (tmpfs) : ce qui est supprimé ici libère de la RAM'}
        </span>
        <span className="spacer" />
        <button
          data-testid="tmp-refresh"
          disabled={clean.busy}
          title="Relire l’occupation et la liste"
          onClick={() => {
            loadStats();
            clean.load();
          }}
        >
          <RefreshCw size={13} strokeWidth={2} /> Actualiser
        </button>
      </div>
      <TmpTiles tiles={tiles} busy={clean.busy} onEmptyQuarantine={() => void clean.emptyQuarantine()} />
      <section className="chart-panel tmp-page-list">
        <div className="chart-panel-head">
          <h3>Éléments de premier niveau</h3>
          {clean.listing && <span className="count">{clean.listing.entries.length}</span>}
          <span className="spacer" />
          <div className="view-toggle tmp-sort" role="group" aria-label="Trier par">
            {SORTS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className={sort === id ? 'active' : ''}
                aria-pressed={sort === id}
                data-testid={`tmp-sort-${id}`}
                title={id === 'size' ? 'Trier par taille décroissante' : 'Trier par nom'}
                onClick={() => setSort(id)}
              >
                <Icon size={13} strokeWidth={2} /> {label}
              </button>
            ))}
          </div>
        </div>
        <TmpCleanList clean={clean} sort={sort} />
      </section>
    </div>
  );
}
