// src/renderer/src/components/DetailTiles.tsx — tuiles du haut du détail : en direct, ou à l'instant survolé / figé du graphe
import type { GroupSummary, MemoryMetric } from '../../../core/types';
import { formatAge, formatCpu, formatKB } from '../format';
import { fallbackTitle, memTileLabel } from '../memMetric';
import { formatInstant } from '../metrics';
import { nowDelta, type NowDelta } from '../nowDelta';
import { tilesAt, type TileValues } from '../replay';
import { useReplaySelect, type ReplayStore } from '../useReplay';
import { useMemo } from 'react';
import { AnimatedNumber } from './ui';

/** Instant examiné : son horodatage et les valeurs lues dans les séries du graphe (null : hors des séries). */
export interface TilesAt { ts: number; values: TileValues | null }

const dash = '—';

/** Écart « alors vs maintenant » sous la valeur passée (positionné en absolu, comme le badge). */
function Delta({ d }: { d: NowDelta | null }) {
  if (!d) return null;
  // Couleur neutre : le signe suffit, sans jugement « mieux / moins bien ».
  return <span className="tile-delta" data-testid="tile-delta" title={d.title}>{d.text}</span>;
}

/** Badge « au HH:MM:SS » d'une tuile à l'instant examiné (positionné en absolu : la hauteur des tuiles ne bouge pas). */
function At({ text }: { text: string }) {
  return <span className="tile-at" data-testid="tile-at">{text}</span>;
}

/**
 * Processus, RAM, Swap, CPU et Plus ancien. Avec `at`, les quatre premières montrent l'instant examiné (sans animation,
 * pour suivre la souris), avec l'écart à maintenant, et « Plus ancien » vaut « — » (l'âge n'est pas enregistré).
 */
export function DetailTiles({ group, memMetric, at, now }: { group: GroupSummary; memMetric: MemoryMetric; at: TilesAt | null; now?: number }) {
  if (at) {
    const v = at.values;
    const badge = `au ${formatInstant(at.ts, now)}`;
    const kb = (n: number | null | undefined) => (n == null ? dash : formatKB(Math.round(n)));
    return (
      <div className="summary is-at" data-testid="detail-tiles">
        <div className="tile" title={v && !v.procRecorded ? 'non enregistré pour cette plage' : undefined}><small>Processus</small><At text={badge} /><b>{v?.procCount ?? dash}</b><Delta d={nowDelta(v?.procCount, group.procCount, 'count')} /></div>
        <div className="tile" title="Mémoire résidente enregistrée par le service (RSS)"><small data-testid="mem-tile-label">RAM</small><At text={badge} /><b>{kb(v?.rssKB)}</b>
          {/* En PSS, le direct n'est pas comparable à l'historique (RSS) : pas d'écart. */}
          {memMetric !== 'pss' && <Delta d={nowDelta(v?.rssKB, group.rssKB, 'kb')} />}
        </div>
        <div className="tile"><small>Swap</small><At text={badge} /><b>{kb(v?.swapKB)}</b><Delta d={nowDelta(v?.swapKB, group.swapKB, 'kb')} /></div>
        <div className="tile"><small>CPU</small><At text={badge} /><b>{v?.cpu == null ? dash : formatCpu(v.cpu)}</b><Delta d={nowDelta(v?.cpu, group.cpuPercent, 'cpu')} /></div>
        <div className="tile"><small>Plus ancien</small><b data-testid="tile-oldest">{dash}</b></div>
      </div>
    );
  }
  return (
    <div className="summary" data-testid="detail-tiles">
      <div className="tile"><small>Processus</small><b>{group.procCount}</b></div>
      <div className="tile" title={fallbackTitle(memMetric, group)}><small data-testid="mem-tile-label">{memTileLabel(memMetric, group)}</small><b><AnimatedNumber value={group.rssKB} /></b></div>
      <div className="tile"><small>Swap</small><b><AnimatedNumber value={group.swapKB} /></b></div>
      <div className="tile"><small>CPU</small><b>{formatCpu(group.cpuPercent)}</b></div>
      <div className="tile"><small>Plus ancien</small><b data-testid="tile-oldest" className={group.oldestAgeSec > 86400 ? 'old' : ''}>{formatAge(group.oldestAgeSec)}</b></div>
    </div>
  );
}

/** Tuiles reliées au rejeu : seules à se re-rendre quand le survol change d'échantillon. */
export function DetailTilesLive({ store, group, memMetric }: { store: ReplayStore; group: GroupSummary; memMetric: MemoryMetric }) {
  const instant = useReplaySelect(store, (c) => c.shown);
  const series = useReplaySelect(store, (c) => c.series);
  const at = useMemo(() => (instant === null ? null : { ts: instant, values: tilesAt(series, instant) }), [instant, series]);
  return <DetailTiles group={group} memMetric={memMetric} at={at} />;
}
