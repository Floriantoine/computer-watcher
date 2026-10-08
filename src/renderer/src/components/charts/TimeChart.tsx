import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotionConfig } from 'motion/react';
import uPlot from 'uplot';
import { stackBands, toAligned, type ChartAxis, type ChartSeries } from './chartData';
import { CURSOR_BG, formatAxisTime, formatTipTime, gradientFill, rgba, themedAxis, toneColors, type ValueFormat } from './uplotTheme';

export type { ChartSeries } from './chartData';

export interface ChartMarker {
  ts: number;
  color: string;
  label: string;
}

interface Props {
  /** Horodatages en ms, croissants. */
  ts: number[];
  series: ChartSeries[];
  height: number;
  /** Format des valeurs par axe (graduations et info-bulle). */
  format: { left: ValueFormat; right?: ValueFormat };
  markers?: ChartMarker[];
  /** Clic sur un instant du graphe. */
  onCursor?: (ts: number) => void;
  /** Glisser : plage sélectionnée ; double-clic : `null` (retour à la plage complète). */
  onSelectRange?: (r: { from: number; to: number } | null) => void;
}

interface Tip {
  idx: number;
  left: number;
  top: number;
  flip: boolean;
}

const MARKER_HIT_PX = 6;

/** Clé de structure : seule sa modification recrée l'instance uPlot ; les données passent par setData. */
function structureKey(series: ChartSeries[]): string {
  return series.map((s) => [s.label, s.tone, s.axis ?? 'left', s.stacked ? 1 : 0, s.fill === false ? 0 : 1, s.emphasis ? 1 : 0, s.dash?.join(',') ?? ''].join('|')).join('§');
}

function span(u: uPlot): number {
  const { min, max } = u.scales.x;
  return min != null && max != null ? max - min : 0;
}

function zeroBased(_u: uPlot, _min: number, max: number): uPlot.Range.MinMax {
  return [0, max > 0 ? max * 1.08 : 1];
}

export function TimeChart({ ts, series, height, format, markers, onCursor, onSelectRange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const reduce = !!useReducedMotionConfig();
  const [tip, setTip] = useState<Tip | null>(null);

  // Valeurs lues par les hooks uPlot sans recréer l'instance.
  const live = useRef({ ts, series, format, markers, onCursor, onSelectRange });
  live.current = { ts, series, format, markers, onCursor, onSelectRange };

  const key = structureKey(series);
  const data = useMemo(() => toAligned(ts, series), [ts, series]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const s0 = live.current.series;
    const hasRight = s0.some((s) => s.axis === 'right');
    const fmt = (axis: ChartAxis) => (axis === 'right' ? live.current.format.right ?? live.current.format.left : live.current.format.left);
    let downX: number | null = null;

    const opts: uPlot.Options = {
      width: Math.max(1, el.clientWidth),
      height,
      ms: 1,
      legend: { show: false },
      padding: [10, hasRight ? 4 : 14, 0, 4],
      scales: {
        x: { time: true },
        left: { range: zeroBased },
        right: { range: zeroBased },
      },
      axes: [
        themedAxis({
          space: 64,
          size: 26,
          grid: { show: false },
          values: (u, splits) => splits.map((v) => formatAxisTime(v, span(u))),
        }),
        themedAxis({
          scale: 'left',
          space: 34,
          size: (u, values) => measure(u, values),
          incrs: fmt('left').incrs,
          values: (_u, splits) => splits.map((v) => fmt('left').fmt(v)),
        }),
        ...(hasRight
          ? [
              themedAxis({
                scale: 'right',
                side: 1,
                space: 34,
                grid: { show: false },
                size: (u: uPlot, values: string[]) => measure(u, values),
                incrs: fmt('right').incrs,
                values: (_u: uPlot, splits: number[]) => splits.map((v) => fmt('right').fmt(v)),
              }),
            ]
          : []),
      ],
      series: [
        {},
        ...s0.map((s): uPlot.Series => {
          const c = toneColors(s.tone);
          const area = s.stacked || s.fill !== false;
          return {
            label: s.label,
            scale: s.axis ?? 'left',
            // Une ligne seule (sans aire) reste en retrait pour ne pas couvrir les aires.
            stroke: area || s.emphasis ? c.line : rgba(c.line, 0.75),
            width: area ? 1.5 : s.emphasis ? 1.75 : 1.25,
            dash: s.dash,
            fill: area ? gradientFill(c.fill, s.stacked ? 0.5 : 0.42, s.stacked ? 0.08 : 0.02) : undefined,
            points: { show: false },
            spanGaps: false,
          };
        }),
      ],
      bands: stackBands(s0),
      cursor: {
        y: false,
        drag: { x: true, y: false, setScale: false, dist: 4 },
        points: {
          size: 7,
          width: 2,
          fill: CURSOR_BG,
          stroke: (u, si) => toneColors(live.current.series[si - 1]?.tone ?? 'mem').line,
        },
      },
      select: { show: true, left: 0, top: 0, width: 0, height: 0 },
      hooks: {
        setCursor: [
          (u) => {
            const { idx, left, top } = u.cursor;
            if (idx == null || left == null || left < 0 || top == null) {
              setTip(null);
              return;
            }
            const x = u.valToPos(live.current.ts[idx] ?? 0, 'x');
            setTip({ idx, left: x, top, flip: x > u.over.clientWidth / 2 });
          },
        ],
        setSelect: [
          (u) => {
            const { left, width } = u.select;
            if (width < 2) return;
            live.current.onSelectRange?.({ from: u.posToVal(left, 'x'), to: u.posToVal(left + width, 'x') });
            u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
          },
        ],
        draw: [(u) => drawMarkers(u, live.current.markers)],
        ready: [
          (u) => {
            u.over.addEventListener('mousedown', (e) => (downX = e.clientX));
            u.over.addEventListener('click', (e) => {
              if (downX != null && Math.abs(e.clientX - downX) > 3) return;
              const { idx, left } = u.cursor;
              if (left == null || left < 0) return;
              const t = idx != null ? live.current.ts[idx] : undefined;
              live.current.onCursor?.(t ?? u.posToVal(left, 'x'));
            });
            u.over.addEventListener('dblclick', () => live.current.onSelectRange?.(null));
            u.over.addEventListener('mouseleave', () => setTip(null));
          },
        ],
      },
    };

    const u = new uPlot(opts, toAligned(live.current.ts, s0), el);
    plot.current = u;
    // Inter peut finir de charger après le premier tracé : on recalcule les axes.
    void document.fonts?.ready.then(() => plot.current === u && u.redraw(false, true));
    const ro = new ResizeObserver(() => {
      const w = Math.max(1, el.clientWidth);
      if (w !== u.width) u.setSize({ width: w, height: u.height });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      plot.current = null;
      setTip(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const u = plot.current;
    if (u && u.height !== height) u.setSize({ width: u.width, height });
  }, [height]);

  useEffect(() => {
    plot.current?.setData(data);
  }, [data]);

  useEffect(() => {
    plot.current?.redraw(false);
  }, [markers]);

  const u = plot.current;
  return (
    <motion.div
      className="time-chart"
      style={{ height }}
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
    >
      <div ref={host} className="time-chart-host" />
      {u && tip && <Tooltip u={u} tip={tip} ts={ts} series={series} format={format} markers={markers} />}
    </motion.div>
  );
}

function measure(u: uPlot, values: string[] | null): number {
  if (!values?.length) return 30;
  u.ctx.save();
  u.ctx.font = '11px Inter, system-ui, sans-serif';
  const w = Math.max(...values.map((v) => u.ctx.measureText(v).width));
  u.ctx.restore();
  return Math.ceil(w) + 14;
}

function drawMarkers(u: uPlot, markers: ChartMarker[] | undefined): void {
  if (!markers?.length) return;
  const { ctx, bbox } = u;
  const { min, max } = u.scales.x;
  if (min == null || max == null) return;
  const pr = uPlot.pxRatio;
  ctx.save();
  for (const m of markers) {
    if (m.ts < min || m.ts > max) continue;
    const x = Math.round(u.valToPos(m.ts, 'x', true)) + 0.5;
    ctx.strokeStyle = rgba(m.color, 0.7);
    ctx.lineWidth = pr;
    ctx.setLineDash([3 * pr, 3 * pr]);
    ctx.beginPath();
    ctx.moveTo(x, bbox.top + 4 * pr);
    ctx.lineTo(x, bbox.top + bbox.height);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = m.color;
    ctx.strokeStyle = CURSOR_BG;
    ctx.lineWidth = 2 * pr;
    ctx.beginPath();
    ctx.arc(x, bbox.top + 4 * pr, 3.5 * pr, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

interface TipProps {
  u: uPlot;
  tip: Tip;
  ts: number[];
  series: ChartSeries[];
  format: Props['format'];
  markers?: ChartMarker[];
}

function Tooltip({ u, tip, ts, series, format, markers }: TipProps) {
  const t = ts[tip.idx];
  if (t === undefined) return null;
  const near = (markers ?? []).filter((m) => Math.abs(u.valToPos(m.ts, 'x') - tip.left) <= MARKER_HIT_PX);
  const ox = u.over.offsetLeft;
  const oy = u.over.offsetTop;
  return (
    <div
      className="chart-tip"
      style={{
        left: ox + tip.left,
        top: oy + Math.min(Math.max(tip.top - 20, 0), Math.max(0, u.over.clientHeight - 90)),
        transform: tip.flip ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
      }}
    >
      <div className="chart-tip-time">{formatTipTime(t, span(u))}</div>
      {series.map((s, i) => {
        const v = (s.raw ?? s.values)[tip.idx];
        const f = s.axis === 'right' ? format.right ?? format.left : format.left;
        return (
          <div key={i} className="chart-tip-row">
            <i style={{ background: toneColors(s.tone).line }} />
            <span>{s.label}</span>
            <b>{v == null ? '—' : (f.tip ?? f.fmt)(v)}</b>
          </div>
        );
      })}
      {near.map((m, i) => (
        <div key={`m${i}`} className="chart-tip-row chart-tip-marker">
          <i style={{ background: m.color }} />
          <span>{m.label}</span>
        </div>
      ))}
    </div>
  );
}
