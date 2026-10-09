import { memo, useEffect, useState } from 'react';
import { FolderOpen, HardDrive, Moon } from 'lucide-react';
import type { SwapRow, SwapView } from '../../../core/swap';
import { formatKB } from '../format';
import { isLive, useHistory } from '../history';
import { barWidth } from '../motionBudget';
import { CLAUDE_NOT_PROPOSED, rowAction, sleepLabel, STOP_SLEEPING_HINT, stopSleepingLabel, swapRuleText, thresholdCommit } from '../swapPanel';
import { CategoryTag, ClaudeLaunchedBadge } from './CategoryTag';
import { Sparkline } from './charts/Sparkline';
import { TmpDirsList } from './TmpDirsList';
import { GroupIcon } from './ui';

interface Props {
  /** Seuil « endormi » (Mo de swap cumulé) : la vue est relue quand il change. */
  minMB: number;
  /** Swap utilisé enregistré (graphe au-dessus de la jauge) ; absent sans historique. */
  swapSeries?: (number | null)[];
  /** Clés des instances endormies éligibles ; le parent les résout dans le dernier snapshot (instances disparues ignorées). */
  onStopSleeping: (keys: readonly string[]) => void;
  onStopOne: (row: SwapRow) => void;
  /** Nouveau seuil validé (Entrée ou sortie du champ) : enregistré dans la config. */
  onSetMinMB: (mb: number) => void;
  /** Ouvre la page /tmp (suppression) depuis l'explorateur en lecture seule ; callback stable (panneau mémoïsé). */
  onOpenTmp?: () => void;
}

const ROWS_SHOWN = 30;
/** Même vue que la précédente (rien n'a bougé) : pas de nouveau rendu. */
const sameView = (a: SwapView | null | undefined, b: SwapView | null) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Onglet Métriques : swap par groupe et instance, état actif / endormi, « Arrêter les endormis ». Relu toutes les 30 s (collecte
 * en pause : rien) ; mémoïsé, il ne se redessine pas à chaque snapshot.
 */
export const SwapPanel = memo(function SwapPanel({ minMB, swapSeries, onStopSleeping, onStopOne, onSetMinMB, onOpenTmp }: Props) {
  const view = useHistory(() => window.procWatch.swap.view(), [minMB], 30_000, sameView);
  const [all, setAll] = useState(false);
  const [tmpOpen, setTmpOpen] = useState(false);
  // Libellés « depuis … » rafraîchis au moins chaque minute tant que le panneau est affiché (et la collecte active).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => isLive() && setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => setNow(Date.now()), [view]);
  const sleeping = view?.sleepingKeys ?? [];
  const pct = view && view.swapTotalKB > 0 ? (view.swapUsedKB / view.swapTotalKB) * 100 : 0;
  const rows = view ? (all ? view.rows : view.rows.slice(0, ROWS_SHOWN)) : [];
  return (
    <section className="chart-panel swap-panel" data-testid="swap-panel">
      <div className="chart-panel-head">
        <h3><HardDrive size={14} strokeWidth={2} /> Swap</h3>
        {view && <span className="sub">{formatKB(view.swapUsedKB)} / {formatKB(view.swapTotalKB)}</span>}
        <span className="spacer" />
        <ThresholdField saved={minMB} onSave={onSetMinMB} />
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
      <p className="hint swap-rule" data-testid="swap-rule">{swapRuleText(minMB, view?.activeCpu ?? 1)}</p>
      {!view ? (
        <div className="chart-empty small">Chargement…</div>
      ) : (
        <div className="swap-rows" role="table" aria-label="Swap par groupe">
          {view.shmemKB !== null && (
            <>
              <div className="swap-row shmem" role="row" data-testid="swap-shmem">
                <span className="ico shmem-ico" aria-hidden><FolderOpen size={14} strokeWidth={2} /></span>
                <span className="name" role="cell" title="RAM + swap, non attribuée aux processus (Shmem) : fichiers tmpfs (/tmp, /dev/shm), mémoire partagée des applis et du bureau">
                  Mémoire partagée (tmpfs, shm…)
                </span>
                <span className="num" role="cell">{formatKB(view.shmemKB)}</span>
                <span className="state" role="cell" />
                <span className="act" role="cell">
                  <button className={`tmpfs-toggle ${tmpOpen ? 'on' : ''}`} aria-expanded={tmpOpen} onClick={() => setTmpOpen((o) => !o)}>Voir</button>
                </span>
              </div>
              {tmpOpen && <div className="swap-tmp"><TmpDirsList onOpenTmp={onOpenTmp} /></div>}
            </>
          )}
          {view.rows.length === 0 && <div className="chart-empty small">Aucun processus dans le swap</div>}
          {rows.map((r) => (
            <SwapGroupRows key={r.key} row={r} now={now} coveredFrom={view.coveredFrom} onStopOne={onStopOne} />
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
});

const SwapGroupRows = memo(function SwapGroupRows({ row, now, coveredFrom, onStopOne }: { row: SwapRow; now: number; coveredFrom: number | null; onStopOne: (r: SwapRow) => void }) {
  return (
    <>
      <Line row={row} now={now} coveredFrom={coveredFrom} onStopOne={onStopOne} />
      {row.children.map((c) => <Line key={c.key} row={c} child now={now} coveredFrom={coveredFrom} onStopOne={onStopOne} />)}
    </>
  );
});

function Line({ row, child, now, coveredFrom, onStopOne }: { row: SwapRow; child?: boolean; now: number; coveredFrom: number | null; onStopOne: (r: SwapRow) => void }) {
  const action = rowAction(row);
  return (
    <div className={`swap-row ${child ? 'child' : ''} st-${row.state.kind}`} role="row" data-testid="swap-row" data-key={row.key}>
      {child ? <span className="tree-gap" aria-hidden /> : <GroupIcon id={row.groupId} kind={row.kind} size="sm" />}
      <span className="name" role="cell" title={row.label}>
        <span className="label">{row.label}</span>
        {row.category && row.category !== 'unknown' && <CategoryTag category={row.category} />}
        {row.bulkEligible && <span className="swap-badge" title={STOP_SLEEPING_HINT}>proposée</span>}
        {row.launchedBy === 'claude' && <ClaudeLaunchedBadge title={row.state.kind === 'sleeping' ? CLAUDE_NOT_PROPOSED : undefined} />}
      </span>
      <span className="num" role="cell">{formatKB(row.swapKB)}</span>
      <span className={`state ${row.state.kind}`} role="cell" title={sleepLabel(row.state, now, coveredFrom)}>{sleepLabel(row.state, now, coveredFrom)}</span>
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

/** Seuil « endormi » dans l'en-tête : enregistré à l'Entrée ou à la sortie du champ ; Échap revient à la valeur enregistrée. */
function ThresholdField({ saved, onSave }: { saved: number; onSave: (mb: number) => void }) {
  const [text, setText] = useState(String(saved));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(String(saved));
    setError(null);
  }, [saved]);
  const commit = (how: 'enter' | 'blur') => {
    const r = thresholdCommit(text, saved, how);
    setText(r.text);
    setError(r.error);
    if (r.save !== null) onSave(r.save);
  };
  return (
    <label className={`swap-threshold ${error ? 'invalid' : ''}`} title={error ?? 'Swap cumulé au-delà duquel un groupe inactif depuis 1 jour est « endormi » (Entrée pour enregistrer)'}>
      <span>Seuil</span>
      <input
        type="text"
        inputMode="numeric"
        value={text}
        aria-label="Seuil « endormi » en Mo de swap"
        aria-invalid={!!error}
        data-testid="swap-threshold"
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit('enter');
          if (e.key === 'Escape') {
            setText(String(saved));
            setError(null);
          }
        }}
        onBlur={() => commit('blur')}
      />
      <span>Mo</span>
      {error && <span className="field-error" role="alert">{error}</span>}
    </label>
  );
}
