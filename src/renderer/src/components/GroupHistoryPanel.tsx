import { useEffect, useMemo, useRef, useState } from 'react';
import { ChartLine, Pause, Play } from 'lucide-react';
import type { RangePreset } from '../../../core/types';
import { useChartZoom, ZoomChip } from '../chartZoom';
import { useHistory } from '../history';
import { eventMarkers, PRESET_MS, refreshMsFor } from '../metrics';
import { groupChartSeries } from './charts/chartData';
import { TimeChart, type ChartMarker } from './charts/TimeChart';
import { KB_FORMAT, PERCENT_FORMAT } from './charts/uplotTheme';
import { RangeSelector } from './RangeSelector';
import { ClickDelay, replayInstant } from '../replay';
import { useReplaySelect, type ReplayStore } from '../useReplay';

const CHART_FORMAT = { left: KB_FORMAT, right: PERCENT_FORMAT };
/** Sans rejeu : un magasin vide (les hooks restent appelés dans le même ordre). */
const EMPTY_STORE = { c: undefined, subscribe: () => () => {} } as unknown as ReplayStore;
const NO_STORE_OR = (s: ReplayStore | undefined) => s ?? EMPTY_STORE;

/**
 * Panneau « Historique » : RAM, swap et CPU du groupe sur la plage choisie, avec les mêmes gestes que l'onglet Métriques.
 * Marqueurs : alertes du groupe et pressions système (survol : infobulle). Avec `replay`, le survol montre le détail à
 * l'instant pointé (aperçu), un clic le fige et « Rejouer » le fait avancer à ×60.
 */
export function GroupHistoryPanel({ groupId, replay: store, markers: extra }: { groupId: string; replay?: ReplayStore; markers?: ChartMarker[] }) {
  const replay = store?.c;
  const [range, setRange] = useState<RangePreset>('1h');
  const z = useChartZoom(PRESET_MS[range]);
  const h = useHistory(() => window.procWatch.history.group(groupId, z.range()), [groupId, range, z.zoom], refreshMsFor(range, z.frozen));
  // Alertes du groupe (fuites, kills de ses processus) et pics de pression système, en marqueurs sur le graphe.
  const events = useHistory(() => window.procWatch.history.events(z.range(), groupId), [groupId, range, z.zoom], refreshMsFor(range, z.frozen));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => z.onData(), [h]);
  const series = useMemo(() => (h ? groupChartSeries(h) : []), [h]);
  const latest = useRef({ replay, h });
  latest.current = { replay, h };
  const [hover, setHover] = useState<number | null>(null);
  const enough = !!h && h.ts.length >= 2;
  // Trait de l'instant figé (ou joué) ; l'aperçu au survol suit déjà le curseur du graphe.
  const pinned = useReplaySelect(NO_STORE_OR(store), (c) => c?.state.instant ?? null);
  const playing = useReplaySelect(NO_STORE_OR(store), (c) => c?.state.playing ?? false);
  const markers = useMemo((): ChartMarker[] => {
    const m: ChartMarker[] = [...eventMarkers(events ?? []), ...(extra ?? [])];
    if (pinned !== null) m.push({ ts: pinned, color: '#e7e9ee', label: 'Instant examiné' });
    return m;
  }, [events, extra, pinned]);
  // Tuiles du détail à l'instant examiné : lues dans ces séries, sans requête.
  const setSeries = replay?.setSeries;
  useEffect(() => setSeries?.(h ?? null), [setSeries, h]);
  // Survol : même instant que le clic (échantillon sous le curseur, ou instant exact sur des buckets d'une heure).
  const onHover = useMemo(() => {
    if (!replay) return undefined;
    const hover = replay.hover;
    return (p: { ts: number; exact: number } | null) => {
      const d = latest.current.h;
      if (p === null || !d || d.ts.length < 2) hover(null);
      // Aperçu calé sur la grille des échantillons : même échantillon → même instant, ni rendu ni requête.
      else hover(p.ts);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replay?.hover]);
  // Panneau démonté (ou graphe vide) : retour au direct de l'aperçu.
  useEffect(() => () => replay?.hover(null), [replay?.hover]);
  // Clic : fige l'instant après 250 ms, sauf si c'est un double-clic (retour du zoom).

  const clicks = useMemo(
    () =>
      new ClickDelay(250, (exact) => {
        const { replay: r, h: d } = latest.current;
        if (!r || !d || d.ts.length < 2) return;
        // Point de la série le plus proche de l'instant cliqué ; sur 7 j / 30 j (buckets d'une heure), l'instant cliqué lui-même.
        const i = d.ts.reduce((best, t, k) => (Math.abs(t - exact) < Math.abs(d.ts[best] - exact) ? k : best), 0);
        r.pick(replayInstant(d.ts[i], exact, d.ts[1] - d.ts[0]));
      }),
    [],
  );
  useEffect(() => () => clicks.dispose(), [clicks]);
  const onSelectRange = (r: { from: number; to: number } | null) => {
    if (r === null) clicks.cancel();
    z.onSelectRange(r);
  };
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
        {replay && pinned !== null && (
          <button
            className="replay-play"
            data-testid="replay-play"
            onClick={() => (playing ? replay.pause() : replay.play(z.view ?? z.range()))}
          >
            {playing ? <Pause size={13} strokeWidth={2} /> : <Play size={13} strokeWidth={2} />}
            {playing ? 'Pause' : 'Rejouer'}
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
          onCursor={replay ? (_t, exact) => clicks.click(exact) : undefined}
          onHover={onHover}
          xRange={z.view}
          onWheel={z.onWheel}
          onDragPan={z.onDragPan}
          onSelectRange={onSelectRange}
        />
      ) : (
        <div className="chart-empty">{h === undefined ? 'Chargement…' : "Pas encore d'historique pour ce groupe"}</div>
      )}
    </section>
  );
}
