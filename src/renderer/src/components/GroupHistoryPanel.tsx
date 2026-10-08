import { useEffect, useMemo, useState } from 'react';
import { ChartLine } from 'lucide-react';
import type { RangePreset } from '../../../core/types';
import { useChartZoom, ZoomChip } from '../chartZoom';
import { useHistory } from '../history';
import { PRESET_MS, refreshMsFor } from '../metrics';
import { groupChartSeries } from './charts/chartData';
import { TimeChart } from './charts/TimeChart';
import { KB_FORMAT, PERCENT_FORMAT } from './charts/uplotTheme';
import { RangeSelector } from './RangeSelector';

const CHART_FORMAT = { left: KB_FORMAT, right: PERCENT_FORMAT };

/** Panneau « Historique » : RAM, swap et CPU du groupe sur la plage choisie, avec les mêmes gestes que l'onglet Métriques. */
export function GroupHistoryPanel({ groupId }: { groupId: string }) {
  const [range, setRange] = useState<RangePreset>('1h');
  const z = useChartZoom(PRESET_MS[range]);
  const h = useHistory(() => window.procWatch.history.group(groupId, z.range()), [groupId, range, z.zoom], refreshMsFor(range, z.frozen));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => z.onData(), [h]);
  const series = useMemo(() => (h ? groupChartSeries(h) : []), [h]);
  const [hover, setHover] = useState<number | null>(null);
  const enough = !!h && h.ts.length >= 2;
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
