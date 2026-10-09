import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Activity, CircleAlert, Cpu, Gauge, HardDrive, MemoryStick, MousePointerClick, Power, RefreshCw, Search } from 'lucide-react';
import type { OpenPort, OpenPortsInfo } from '../../../core/openPorts';
import type { SwapRow } from '../../../core/swap';
import type { Culprit, RangePreset, TimeRange } from '../../../core/types';
import { formatKB } from '../format';
import { useHistory } from '../history';
import { ipcErrorMessage } from '../viewModel';
import {
  breakdownAt, eventMarkers, fetchMetrics, formatInstant, INVESTIGATION_LAYERS, investigationSeries, PRESET_MS, refreshMsFor, REST_HINTS, REST_KEYS, REST_TONES,
} from '../metrics';
import { useChartZoom, ZoomChip } from '../chartZoom';
import { AlertsPanel } from './AlertsPanel';
import type { SettingsSection } from '../settingsNav';
import { CulpritsPanel } from './CulpritsPanel';
import { OpenPortsPanel } from './OpenPortsPanel';
import { SwapPanel } from './SwapPanel';
import { seriesIndexOf, type ChartSeries } from './charts/chartData';
import { TimeChart, type ChartMarker } from './charts/TimeChart';
import { KB_FORMAT, PERCENT_FORMAT, type ChartTone, type ValueFormat } from './charts/uplotTheme';
import { RangeSelector } from './RangeSelector';
import { TopConsumers } from './TopConsumers';

interface Props {
  /** Instant à examiner à l'ouverture (alerte cliquée ailleurs) : curseur placé et coupables ouverts. */
  at?: number;
  canOpen: (key: string) => boolean;
  onOpenGroup: (key: string) => void;
  /** Lien vers une section des Réglages (ex. Alertes). */
  onOpenSettings?: (section: SettingsSection) => void;
  /** Panneau « Ports ouverts » (sous les alertes) ; absent sans `onFreePort`. */
  openPorts?: OpenPortsInfo | null;
  pendingPids?: Set<number>;
  onFreePort?: (row: OpenPort) => void;
  onOpenPortGroup?: (groupId: string) => void;
  /** Panneau « Swap » (sous les ports) : seuil « endormi » (Mo) ; absent sans les actions. */
  swapMinMB?: number;
  onStopSleeping?: (keys: readonly string[]) => void;
  onStopSwapRow?: (row: SwapRow) => void;
  onSetSwapMinMB?: (mb: number) => void;
  /** « Voir /tmp » (alerte « fichiers en mémoire », explorateur du swap) : ouvre la page /tmp. */
  onOpenTmp?: () => void;
}

/** Teintes des couches de l'enquête (de la plus grosse à la 8e) ; les trois couches du Reste ont les leurs, en pointillés. */
const LAYER_TONES: ChartTone[] = ['#7c5cff', '#ff5c8a', '#22d3a6', '#ffb547', '#3dd6ff', '#ff8a3d', '#c084fc', '#a3e635'];
const REST_HINT_BY_KEY = new Map<string, string>([
  [REST_KEYS.others, REST_HINTS.others], [REST_KEYS.shmem, REST_HINTS.shmem], [REST_KEYS.kernel, REST_HINTS.kernel],
]);
const REST_TONE_BY_KEY = new Map<string, ChartTone>([
  [REST_KEYS.others, REST_TONES.others], [REST_KEYS.shmem, REST_TONES.shmem], [REST_KEYS.kernel, REST_TONES.kernel],
]);
const KB = { left: KB_FORMAT };
const PCT = { left: PERCENT_FORMAT };
const H = 3_600_000;


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

const NO_PIDS = new Set<number>();

export function MetricsView({ at, canOpen, onOpenGroup, onOpenSettings, openPorts, pendingPids = NO_PIDS, onFreePort, onOpenPortGroup, swapMinMB = 100, onStopSleeping, onStopSwapRow, onSetSwapMinMB, onOpenTmp }: Props) {
  const [preset, setPreset] = useState<RangePreset>(() => presetFor(at));
  const z = useChartZoom(PRESET_MS[preset]);
  const { zoom, view, setZoom } = z;
  const [cursor, setCursor] = useState<number | null>(at ?? null);
  const [statusGen, setStatusGen] = useState(0);
  const [enableError, setEnableError] = useState<string | null>(null);
  const [reloadGen, setReloadGen] = useState(0);

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
    () => fetchMetrics(window.procWatch.history, z.range()),
    [preset, zoom, reloadGen],
    // Zoom figé : rien ne bouge, pas de rafraîchissement ; zoom en direct : comme la plage complète.
    refreshMsFor(preset, z.frozen),
  );
  // En direct, la fenêtre affichée est celle des données fraîches (elle avance à chaque rafraîchissement).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => z.onData(), [data]);
  const system = data?.system;
  const events = data?.events;
  const swapSeries = system && system.ts.length >= 2 ? system.swapUsedKB : undefined;

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
    // totaux du système alignés sur les horodatages des groupes (mêmes buckets)
    const at = new Map(system.ts.map((t, i) => [t, i]));
    const align = (f: (i: number) => number | null) => g.ts.map((t) => {
      const i = at.get(t);
      return i === undefined ? null : f(i);
    });
    const r = investigationSeries(g, INVESTIGATION_LAYERS, {
      usedKB: align((i) => system.memUsedKB[i] + system.swapUsedKB[i]),
      shmemKB: align((i) => system.shmemKB?.[i] ?? null),
      groupsKB: align((i) => system.groupsKB?.[i] ?? null),
    });
    const series: ChartSeries[] = r.layers.map((l, i) => {
      const rest = REST_TONE_BY_KEY.get(l.key);
      return { label: l.label, values: l.values, tone: rest ?? LAYER_TONES[i % LAYER_TONES.length], fill: false, emphasis: true, dash: rest ? [4, 4] : undefined };
    });
    return { ts: r.ts, series, keys: r.layers.map((l) => l.key), raw: r };
  }, [data?.groups, system]);

  // Survol d'un groupe (Top, légende) ou d'une alerte : mise en avant dans les graphes.
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [hoverTs, setHoverTs] = useState<number | null>(null);
  const focusSeries = inv ? seriesIndexOf(inv.keys, hoverKey) : null;

  const markers = useMemo((): ChartMarker[] => {
    const m: ChartMarker[] = eventMarkers(events ?? []);
    if (cursor !== null) m.push({ ts: cursor, color: '#e7e9ee', label: 'Instant examiné' });
    return m;
  }, [events, cursor]);

  const pickPreset = (p: RangePreset) => {
    setZoom(null);
    setPreset(p);
  };

  return (
    <div className="metrics" data-testid="metrics-view">
      <div className="toolbar metrics-toolbar">
        <RangeSelector value={preset} onChange={pickPreset} />
        <ZoomChip zoom={zoom} onReset={() => setZoom(null)} />
        {!zoom && refreshMsFor(preset, false) === null && (
          <button onClick={() => setReloadGen((n) => n + 1)} data-testid="metrics-refresh" title="Les plages de 7 et 30 jours ne se rafraîchissent pas toutes seules">
            <RefreshCw size={13} strokeWidth={2} /> Actualiser
          </button>
        )}
        <span className="spacer" />
        <span className="sub hint">Glisser ou Ctrl + molette pour zoomer · clic molette ou Maj + molette pour se déplacer · double-clic pour revenir · clic pour les coupables</span>
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
              <TimeChart ts={system!.ts} series={c.series} height={96} format={c.format} markers={markers} focusMarker={hoverTs} markerLabels={false} xRange={view} onWheel={z.onWheel} onDragPan={z.onDragPan} onCursor={setCursor} onSelectRange={z.onSelectRange} />
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
          </div>
          {inv ? (
            <>
              <div className="inv-legend" onMouseLeave={() => setHoverKey(null)}>
                {inv.series.map((s, i) => (
                  <span key={i} className={focusSeries !== null && focusSeries !== i ? 'dim' : ''} title={REST_HINT_BY_KEY.get(inv.keys[i])} onMouseEnter={() => setHoverKey(inv.keys[i])}>
                    <i style={{ background: s.tone }} />{s.label}
                  </span>
                ))}
              </div>
              <TimeChart ts={inv.ts} series={inv.series} height={320} format={KB} markers={markers} focusSeries={focusSeries} focusMarker={hoverTs} xRange={view} onWheel={z.onWheel} onDragPan={z.onDragPan} onCursor={setCursor} onSelectRange={z.onSelectRange} />
            </>
          ) : (
            <div className="chart-empty tall">{data === undefined ? 'Chargement…' : 'Pas encore assez de données pour l’enquête'}</div>
          )}
        </section>
      </div>

      {/* Trois colonnes de même hauteur : instant cliqué | top | alertes ; chacune défile si besoin. */}
      <div className="metrics-bottom">
        <section className="chart-panel culprits-col" data-testid="culprits-col">
          <AnimatePresence initial={false} mode="wait">
            {cursor !== null ? (
              <motion.div
                key="culprits"
                className="culprits-anim"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
              >
                <CulpritsPanel
                  ts={cursor}
                  breakdown={inv ? breakdownAt(inv.raw, cursor) : null}
                  culprits={culprits && culprits.ts === cursor ? culprits.list : undefined}
                  canOpen={canOpen}
                  onOpenGroup={onOpenGroup}
                  onClose={() => setCursor(null)}
                />
              </motion.div>
            ) : (
              <motion.div
                key="hint"
                className="culprits-hint"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
              >
                <MousePointerClick size={18} strokeWidth={1.8} />
                <span>Cliquez un instant du graphe pour voir ce qui a grossi</span>
              </motion.div>
            )}
          </AnimatePresence>
        </section>
        <TopConsumers top={data?.top} canOpen={canOpen} onOpenGroup={onOpenGroup} onHover={setHoverKey} />
        <AlertsPanel events={events} onPick={setCursor} onHover={setHoverTs} onSettings={onOpenSettings && (() => onOpenSettings('alerts'))} onOpenTmp={onOpenTmp} />
      </div>
      {onFreePort && onOpenPortGroup && <OpenPortsPanel info={openPorts ?? null} pendingPids={pendingPids} onFree={onFreePort} onOpenGroup={onOpenPortGroup} />}
      {onStopSleeping && onStopSwapRow && onSetSwapMinMB && (
        <SwapPanel minMB={swapMinMB} swapSeries={swapSeries} onStopSleeping={onStopSleeping} onStopOne={onStopSwapRow} onSetMinMB={onSetSwapMinMB} onOpenTmp={onOpenTmp} />
      )}
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
