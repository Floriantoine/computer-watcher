import { useEffect, useMemo, useState } from 'react';
import { ChartLine, Pause, Play } from 'lucide-react';
import type { RangePreset } from '../../../core/types';
import { useChartZoom, ZoomChip } from '../chartZoom';
import { useHistory } from '../history';
import { PRESET_MS, refreshMsFor } from '../metrics';
import { groupChartSeries } from './charts/chartData';
import { TimeChart, type ChartMarker } from './charts/TimeChart';
import { KB_FORMAT, PERCENT_FORMAT } from './charts/uplotTheme';
import { RangeSelector } from './RangeSelector';
import type { Replay } from '../useReplay';

const CHART_FORMAT = { left: KB_FORMAT, right: PERCENT_FORMAT };

/**
 * Panneau « Historique » : RAM, swap et CPU du groupe sur la plage choisie, avec les mêmes gestes que l'onglet Métriques.
 * Avec `replay`, un clic fige l'instant examiné (rejeu de l'arbre) et « Rejouer » le fait avancer à ×60.
 */
export function GroupHistoryPanel({ groupId, replay, markers: extra }: { groupId: string; replay?: Replay; markers?: ChartMarker[] }) {
  const [range, setRange] = useState<RangePreset>('1h');
  const z = useChartZoom(PRESET_MS[range]);
  const h = useHistory(() => window.procWatch.history.group(groupId, z.range()), [groupId, range, z.zoom], refreshMsFor(range, z.frozen));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => z.onData(), [h]);
  const series = useMemo(() => (h ? groupChartSeries(h) : []), [h]);
  const [hover, setHover] = useState<number | null>(null);
  const enough = !!h && h.ts.length >= 2;
  const instant = replay?.instant ?? null;
  const markers = useMemo((): ChartMarker[] => {
    const m: ChartMarker[] = [...(extra ?? [])];
    if (instant !== null) m.push({ ts: instant, color: '#e7e9ee', label: 'Instant examiné' });
    return m;
  }, [extra, instant]);
  const pickRange = (r: RangePreset) => {
    z.setZoom(null);
    setRange(r);
  };
  return (
    <section className="chart-panel" data-testid="group-history">
      <div className="chart-panel-head">
        <h3><ChartLine size={14} strokeWidth={2} /> Historique</h3>
        {enough && (
          <span className="chart-legend" onMouseLeave={() => setHover(null)}>
            {(['lg-mem', 'lg-swap', 'lg-cpu'] as const).map((cls, i) => (
              <span key={cls} className={hover !== null && hover !== i ? 'dim' : ''} onMouseEnter={() => setHover(i)}>
                <i className={cls} />{series[i]?.label}
              </span>
            ))}
          </span>
        )}
        <span className="spacer" />
        {replay && instant !== null && (
          <button
            className="replay-play"
            data-testid="replay-play"
            onClick={() => (replay.playing ? replay.pause() : replay.play(z.view ?? z.range()))}
          >
            {replay.playing ? <Pause size={13} strokeWidth={2} /> : <Play size={13} strokeWidth={2} />}
            {replay.playing ? 'Pause' : 'Rejouer'}
          </button>
        )}
        <ZoomChip zoom={z.zoom} onReset={() => z.setZoom(null)} />
        <RangeSelector value={range} onChange={pickRange} />
      </div>
      {enough ? (
        <TimeChart
          ts={h.ts}
          series={series}
          height={190}
          format={CHART_FORMAT}
          focusSeries={hover}
          markers={markers}
          onCursor={replay?.pick}
          xRange={z.view}
          onWheel={z.onWheel}
          onDragPan={z.onDragPan}
          onSelectRange={z.onSelectRange}
        />
      ) : (
        <div className="chart-empty">{h === undefined ? 'Chargement…' : "Pas encore d'historique pour ce groupe"}</div>
      )}
    </section>
  );
}
