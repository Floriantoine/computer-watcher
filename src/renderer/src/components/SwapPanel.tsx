import { memo, useState } from 'react';
import { FolderOpen, HardDrive, Moon, Settings2 } from 'lucide-react';
import type { SwapRow, SwapView } from '../../../core/swap';
import type { GroupSummary, InstanceSummary } from '../../../core/types';
import { formatKB } from '../format';
import { useHistory } from '../history';
import { barWidth } from '../motionBudget';
import { rowAction, sleepLabel, sleepingInstances, STOP_SLEEPING_HINT, stopSleepingLabel } from '../swapPanel';
import { CategoryTag } from './CategoryTag';
import { Sparkline } from './charts/Sparkline';
import { TmpDirsList } from './TmpDirsList';
import { GroupIcon } from './ui';

interface Props {
  /** Groupes du dernier snapshot : instances proposées à « Arrêter les endormis ». */
  groups: readonly GroupSummary[];
  /** Seuil « endormi » (Mo de swap cumulé) : la vue est relue quand il change. */
  minMB: number;
  /** Swap utilisé enregistré (graphe au-dessus de la jauge) ; absent sans historique. */
  swapSeries?: (number | null)[];
  onStopSleeping: (instances: InstanceSummary[]) => void;
  onStopOne: (row: SwapRow) => void;
  onSettings?: () => void;
}

const ROWS_SHOWN = 30;
/** Même vue que la précédente (rien n'a bougé) : pas de nouveau rendu. */
const sameView = (a: SwapView | null | undefined, b: SwapView | null) => JSON.stringify(a) === JSON.stringify(b);

/** Onglet Métriques : swap par groupe et instance, état actif / endormi, « Arrêter les endormis ». Relu toutes les 30 s (collecte en pause : rien). */
export function SwapPanel({ groups, minMB, swapSeries, onStopSleeping, onStopOne, onSettings }: Props) {
  const view = useHistory(() => window.procWatch.swap.view(), [minMB], 30_000, sameView);
  const [all, setAll] = useState(false);
  const [tmpOpen, setTmpOpen] = useState(false);
  const now = Date.now();
  const sleeping = sleepingInstances(view, groups);
  const pct = view && view.swapTotalKB > 0 ? (view.swapUsedKB / view.swapTotalKB) * 100 : 0;
  const rows = view ? (all ? view.rows : view.rows.slice(0, ROWS_SHOWN)) : [];
  return (
    <section className="chart-panel swap-panel" data-testid="swap-panel">
      <div className="chart-panel-head">
        <h3><HardDrive size={14} strokeWidth={2} /> Swap</h3>
        {view && <span className="sub">{formatKB(view.swapUsedKB)} / {formatKB(view.swapTotalKB)}</span>}
        <span className="spacer" />
        <span title={STOP_SLEEPING_HINT}>
          <button className="danger" data-testid="swap-stop-sleeping" disabled={sleeping.length === 0} onClick={() => onStopSleeping(sleeping)}>
            <Moon size={12} strokeWidth={2.2} /> {stopSleepingLabel(sleeping.length)}
          </button>
        </span>
      </div>
      <div className="swap-gauge">
        {swapSeries && <Sparkline values={swapSeries} tone="swap" height={26} />}
        <div className="bar"><i className="tone-swap" style={{ width: barWidth(pct) }} /></div>
      </div>
      <p className="hint swap-rule">
        Endormi : plus de {minMB} Mo de swap cumulé et aucun CPU ≥ 1 % depuis 1 jour.
        {onSettings && (
          <button className="link" onClick={onSettings} title="Réglages › Affichage">
            <Settings2 size={11} strokeWidth={2.2} /> Seuil
          </button>
        )}
      </p>
      {!view ? (
        <div className="chart-empty small">Chargement…</div>
      ) : (
        <div className="swap-rows" role="table" aria-label="Swap par groupe">
          {view.shmemKB !== null && (
            <>
              <div className="swap-row shmem" role="row" data-testid="swap-shmem">
                <span className="ico shmem-ico" aria-hidden><FolderOpen size={14} strokeWidth={2} /></span>
                <span className="name" role="cell">Fichiers en mémoire (/tmp, shm)</span>
                <span className="num" role="cell">{formatKB(view.shmemKB)}</span>
                <span className="state" role="cell" />
                <span className="act" role="cell">
                  <button className={`tmpfs-toggle ${tmpOpen ? 'on' : ''}`} aria-expanded={tmpOpen} onClick={() => setTmpOpen((o) => !o)}>Voir</button>
                </span>
              </div>
              {tmpOpen && <div className="swap-tmp"><TmpDirsList /></div>}
            </>
          )}
          {view.rows.length === 0 && <div className="chart-empty small">Aucun processus dans le swap</div>}
          {rows.map((r) => (
            <SwapGroupRows key={r.key} row={r} now={now} historyFrom={view.historyFrom} onStopOne={onStopOne} />
          ))}
          {view.rows.length > ROWS_SHOWN && (
            <button className="link swap-more" onClick={() => setAll((a) => !a)}>
              {all ? 'Afficher moins' : `Afficher tout (${view.rows.length})`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

const SwapGroupRows = memo(function SwapGroupRows({ row, now, historyFrom, onStopOne }: { row: SwapRow; now: number; historyFrom: number | null; onStopOne: (r: SwapRow) => void }) {
  return (
    <>
      <Line row={row} now={now} historyFrom={historyFrom} onStopOne={onStopOne} />
      {row.children.map((c) => <Line key={c.key} row={c} child now={now} historyFrom={historyFrom} onStopOne={onStopOne} />)}
    </>
  );
});

function Line({ row, child, now, historyFrom, onStopOne }: { row: SwapRow; child?: boolean; now: number; historyFrom: number | null; onStopOne: (r: SwapRow) => void }) {
  const action = rowAction(row);
  return (
    <div className={`swap-row ${child ? 'child' : ''} st-${row.state.kind}`} role="row" data-testid="swap-row" data-key={row.key}>
      {child ? <span className="tree-gap" aria-hidden /> : <GroupIcon id={row.groupId} kind={row.kind} size="sm" />}
      <span className="name" role="cell" title={row.label}>
        <span className="label">{row.label}</span>
        {row.category && row.category !== 'unknown' && <CategoryTag category={row.category} />}
        {row.bulkEligible && <span className="swap-badge" title={STOP_SLEEPING_HINT}>proposée</span>}
      </span>
      <span className="num" role="cell">{formatKB(row.swapKB)}</span>
      <span className={`state ${row.state.kind}`} role="cell">{sleepLabel(row.state, now, historyFrom)}</span>
      <span className="act" role="cell">
        {action === 'stop-one' && (
          <button className="danger" data-testid="swap-stop-one" onClick={() => onStopOne(row)} title="Arrêter ce groupe (confirmation)">
            Arrêter
          </button>
        )}
      </span>
    </div>
  );
}
