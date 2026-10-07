import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Activity, CircleAlert, Cpu, Gauge, HardDrive, MemoryStick, Power, RotateCcw, Search, ZoomIn } from 'lucide-react';
import type { Culprit, RangePreset, TimeRange } from '../../../core/types';
import { formatKB } from '../format';
import { useHistory } from '../history';
import { ipcErrorMessage } from '../viewModel';
import { eventMarkers, fetchMetrics, formatInstant, INVESTIGATION_LAYERS, investigationSeries } from '../metrics';
import { AlertsPanel } from './AlertsPanel';
import { CulpritsPanel } from './CulpritsPanel';
import type { ChartSeries } from './charts/chartData';
import { TimeChart, type ChartMarker } from './charts/TimeChart';
import { formatAxisTime, KB_FORMAT, PERCENT_FORMAT, type ChartTone, type ValueFormat } from './charts/uplotTheme';
import { RangeSelector } from './RangeSelector';
import { TopConsumers } from './TopConsumers';

interface Props {
  /** Instant à examiner à l'ouverture (alerte cliquée ailleurs) : curseur placé et coupables ouverts. */
  at?: number;
  canOpen: (key: string) => boolean;
  onOpenGroup: (key: string) => void;
}

const H = 3_600_000;
const PRESET_MS: Record<RangePreset, number> = { '1h': H, '6h': 6 * H, '24h': 24 * H, '7d': 7 * 24 * H, '30d': 30 * 24 * H };
const REFRESH_MS = 30_000;
const MIN_ZOOM_MS = 10 * 60_000;
/** Teintes des couches de l'enquête (de la plus grosse à la 8e), puis « Reste » en gris. */
const LAYER_TONES: ChartTone[] = ['#7c5cff', '#ff5c8a', '#22d3a6', '#ffb547', '#3dd6ff', '#ff8a3d', '#c084fc', '#a3e635'];
const REST_TONE: ChartTone = '#6b7180';
const KB = { left: KB_FORMAT };
const PCT = { left: PERCENT_FORMAT };

/** Plus petite plage qui montre encore l'instant `at` (24 h au minimum, pour garder du contexte). */
function presetFor(at: number | undefined): RangePreset {
  if (at === undefined) return '24h';
  const age = Date.now() - at;
  return age < 23 * H ? '24h' : age < 6.9 * 24 * H ? '7d' : '30d';
}

const last = <T,>(a: T[]): T | undefined => a[a.length - 1];

interface SysChart {
  id: string;
  title: string;
  icon: ReactNode;
  value: string;
  sub: string;
  series: ChartSeries[];
  format: { left: ValueFormat };
}

export function MetricsView({ at, canOpen, onOpenGroup }: Props) {
  const [preset, setPreset] = useState<RangePreset>(() => presetFor(at));
  const [zoom, setZoom] = useState<TimeRange | null>(null);
  const [cursor, setCursor] = useState<number | null>(at ?? null);
  const [statusGen, setStatusGen] = useState(0);
  const [enableError, setEnableError] = useState<string | null>(null);

  useEffect(() => {
    if (at === undefined) return;
    setZoom(null);
    setPreset(presetFor(at));
    setCursor(at);
  }, [at]);

  const status = useHistory(() => window.procWatch.recorder.status(), [statusGen]);

  // Une seule plage explicite pour toutes les requêtes : mêmes buckets, donc mêmes horodatages pour le système et les groupes.
  const data = useHistory(
    // Enquête : on ne charge que les groupes aux plus hauts pics ; le reste est déduit de la mémoire totale du système.
    () => fetchMetrics(window.procWatch.history, zoom ?? { from: Date.now() - PRESET_MS[preset], to: Date.now() }),
    [preset, zoom],
    zoom ? null : REFRESH_MS,
  );
  const system = data?.system;
  const events = data?.events;

  const culprits = useHistory(
    async (): Promise<{ ts: number; list: Culprit[] } | null> =>
      cursor === null ? null : { ts: cursor, list: await window.procWatch.history.culprits(cursor) },
    [cursor],
    null,
  );

  const sysCharts = useMemo((): SysChart[] | null => {
    if (!system || system.ts.length < 2) return null;
    const pct = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v)} %`);
    const peak = (a: (number | null)[]) => Math.max(0, ...a.map((v) => v ?? 0));
    return [
      {
        id: 'ram', title: 'RAM', icon: <MemoryStick size={13} strokeWidth={2} />,
        value: formatKB(last(system.memUsedKB) ?? 0), sub: `sur ${formatKB(system.memTotalKB)} · pic ${formatKB(peak(system.memUsedKB))}`,
        series: [{ label: 'RAM', values: system.memUsedKB, tone: 'mem' }], format: KB,
      },
      {
        id: 'swap', title: 'Swap', icon: <HardDrive size={13} strokeWidth={2} />,
        value: formatKB(last(system.swapUsedKB) ?? 0), sub: `sur ${formatKB(system.swapTotalKB)} · pic ${formatKB(peak(system.swapUsedKB))}`,
        series: [{ label: 'Swap', values: system.swapUsedKB, tone: 'swap' }], format: KB,
      },
      {
        id: 'psi', title: 'Pression', icon: <Gauge size={13} strokeWidth={2} />,
        value: pct(last(system.psi)), sub: `pic ${pct(peak(system.psi))}`,
        series: [{ label: 'Pression', values: system.psi, tone: 'psi' }], format: PCT,
      },
      {
        id: 'cpu', title: 'CPU', icon: <Cpu size={13} strokeWidth={2} />,
        value: pct(last(system.cpu)), sub: `pic ${pct(peak(system.cpu))}`,
        series: [{ label: 'CPU', values: system.cpu, tone: 'cpu' }], format: PCT,
      },
    ];
  }, [system]);

  const inv = useMemo(() => {
    const g = data?.groups;
    if (!g || !system || g.ts.length < 2) return null;
    const totalAt = new Map(system.ts.map((t, i) => [t, system.memUsedKB[i] + system.swapUsedKB[i]]));
    const r = investigationSeries(g, INVESTIGATION_LAYERS, g.ts.map((t) => totalAt.get(t) ?? null));
    const series: ChartSeries[] = r.layers.map((l, i) => ({
      label: l.label,
      values: l.values,
      raw: l.raw,
      tone: l.key === '__rest' ? REST_TONE : LAYER_TONES[i % LAYER_TONES.length],
      stacked: true,
    }));
    return { ts: r.ts, series };
  }, [data?.groups, system]);

  const markers = useMemo((): ChartMarker[] => {
    const m: ChartMarker[] = eventMarkers(events ?? []);
    if (cursor !== null) m.push({ ts: cursor, color: '#e7e9ee', label: 'Instant examiné' });
    return m;
  }, [events, cursor]);

  // Zoom d'au moins 10 min : en deçà, l'axe du temps (HH:mm) répéterait les mêmes graduations.
  const onSelectRange = (r: { from: number; to: number } | null) => {
    if (!r) return setZoom(null);
    const mid = (r.from + r.to) / 2;
    const half = Math.max(r.to - r.from, MIN_ZOOM_MS) / 2;
    setZoom({ from: Math.round(mid - half), to: Math.round(mid + half) });
  };
  const pickPreset = (p: RangePreset) => {
    setZoom(null);
    setPreset(p);
  };

  return (
    <div className="metrics" data-testid="metrics-view">
      <div className="toolbar metrics-toolbar">
        <RangeSelector value={preset} onChange={pickPreset} />
        {zoom && (
          <>
            <span className="zoom-chip mono"><ZoomIn size={12} strokeWidth={2} />{formatAxisTime(zoom.from, zoom.to - zoom.from)} → {formatAxisTime(zoom.to, zoom.to - zoom.from)}</span>
            <button onClick={() => setZoom(null)} data-testid="reset-zoom">
              <RotateCcw size={13} strokeWidth={2} /> Réinitialiser le zoom
            </button>
          </>
        )}
        <span className="spacer" />
        <span className="sub hint">Glisser pour zoomer · double-clic pour revenir · clic pour les coupables</span>
      </div>

      <StatusBanner
        status={status}
        noData={data !== undefined && (!system || system.ts.length < 2) && !zoom}
        error={enableError}
        onEnable={() => {
          setEnableError(null);
          window.procWatch.recorder.setEnabled(true).then(
            () => setStatusGen((n) => n + 1),
            (e: unknown) => setEnableError(`Activation impossible : ${ipcErrorMessage(e)}`),
          );
        }}
      />

      <div className="sys-charts">
        {(sysCharts ?? [
          { id: 'ram', title: 'RAM' }, { id: 'swap', title: 'Swap' }, { id: 'psi', title: 'Pression' }, { id: 'cpu', title: 'CPU' },
        ]).map((c) => (
          <section key={c.id} className="chart-panel sys-chart" data-testid={`sys-chart-${c.id}`}>
            <div className="sys-chart-head">
              <small>{'icon' in c && c.icon}{c.title}</small>
              {'value' in c && <b>{c.value}</b>}
              {'sub' in c && <span className="sub">{c.sub}</span>}
            </div>
            {'series' in c ? (
              <TimeChart ts={system!.ts} series={c.series} height={96} format={c.format} markers={markers} onCursor={setCursor} onSelectRange={onSelectRange} />
            ) : (
              <div className="chart-empty small">{data === undefined ? 'Chargement…' : 'Pas de données'}</div>
            )}
          </section>
        ))}
      </div>

      <div className="investigation">
        <section className="chart-panel inv-chart" data-testid="investigation">
          <div className="chart-panel-head">
            <h3><Search size={14} strokeWidth={2} /> Enquête — mémoire par groupe</h3>
            <span className="spacer" />
            {cursor === null && inv && <span className="sub">Cliquez un instant pour voir les coupables</span>}
          </div>
          {inv ? (
            <>
              <div className="inv-legend">
                {inv.series.map((s, i) => (
                  <span key={i}><i style={{ background: s.tone }} />{s.label}</span>
                ))}
              </div>
              <TimeChart ts={inv.ts} series={inv.series} height={260} format={KB} markers={markers} onCursor={setCursor} onSelectRange={onSelectRange} />
            </>
          ) : (
            <div className="chart-empty tall">{data === undefined ? 'Chargement…' : 'Pas encore assez de données pour l’enquête'}</div>
          )}
        </section>
        <AnimatePresence initial={false}>
          {cursor !== null && (
            <motion.div
              key="culprits"
              className="culprits-wrap"
              initial={{ opacity: 0, x: 32 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 32 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            >
              <CulpritsPanel
                ts={cursor}
                culprits={culprits && culprits.ts === cursor ? culprits.list : undefined}
                canOpen={canOpen}
                onOpenGroup={onOpenGroup}
                onClose={() => setCursor(null)}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="metrics-bottom">
        <TopConsumers top={data?.top} canOpen={canOpen} onOpenGroup={onOpenGroup} />
        <AlertsPanel events={events} onPick={setCursor} />
      </div>
    </div>
  );
}

function StatusBanner({ status, noData, error, onEnable }: { status: Awaited<ReturnType<typeof window.procWatch.recorder.status>> | undefined; noData: boolean; error: string | null; onEnable: () => void }) {
  let content: ReactNode = null;
  if (status && !status.enabled) {
    content = (
      <>
        <Power size={15} strokeWidth={2} />
        <span><b>Enregistrement désactivé.</b> {error ?? 'Aucun nouvel historique n’est collecté.'}</span>
        <span className="spacer" />
        <button onClick={onEnable} disabled={!status.available}>Activer</button>
      </>
    );
  } else if (status && !status.available) {
    content = (
      <>
        <CircleAlert size={15} strokeWidth={2} />
        <span><b>Enregistrement indisponible :</b> pas de session systemd utilisateur.</span>
      </>
    );
  } else if (status && !status.running) {
    const lastAt = status.status?.lastSampleAt;
    content = (
      <>
        <CircleAlert size={15} strokeWidth={2} />
        <span>
          <b>Le service ne répond pas.</b>
          {lastAt ? ` Dernier échantillon : ${formatInstant(lastAt)}.` : ' Aucun échantillon reçu.'}
        </span>
      </>
    );
  } else if (noData) {
    content = (
      <>
        <Activity size={15} strokeWidth={2} />
        <span>Pas encore de données, revenez dans quelques minutes.</span>
      </>
    );
  }
  return (
    <AnimatePresence initial={false}>
      {content && (
        <motion.div
          className="metrics-banner"
          data-testid="recorder-banner"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2 }}
        >
          {content}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
