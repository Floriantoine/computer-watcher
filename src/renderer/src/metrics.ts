import { ruleEventText } from '../../core/alerts';
import { topKeysByMax } from '../../core/history/series';
import type { GroupsHistory, HistoryEvent, RangePreset, SystemSeries, TimeRange, TopOptions, TopResult } from '../../core/types';
import { formatKB } from './format';

/** Couches du « Reste » (tout ce qui n'est pas dans le top n), dans l'ordre d'affichage. */
export const REST_KEYS = { others: '__others', shmem: '__shmem', kernel: '__kernel' } as const;
export const REST_LABELS = { others: 'Autres groupes', shmem: 'Fichiers en mémoire (/tmp, shm)', kernel: 'Noyau et caches (estimation)' } as const;
/** Infobulles des couches (légende du graphe, panneau de l'instant). */
export const REST_HINTS = {
  others: 'Somme des groupes hors des courbes nommées',
  shmem: 'Shmem : fichiers de /tmp et /dev/shm, mémoire partagée',
  kernel:
    'Mémoire utilisée − somme de tous les groupes − Shmem. Le RSS des groupes compte plusieurs fois les pages partagées : '
    + 'cette estimation est un minimum (souvent 0).',
} as const;
/** Teintes des trois couches (courbes en pointillés, pastilles du panneau de l'instant). */
export const REST_TONES = { others: '#6b7180', shmem: '#e879f9', kernel: '#94a3b8' } as const;

/** Totaux système alignés sur les horodatages de l'enquête. */
export interface RestTotals { usedKB: (number | null)[]; shmemKB: (number | null)[]; groupsKB: (number | null)[] }
export interface RestSplit { others: number | null; shmem: number | null; kernel: number | null }

const pos = (v: number) => Math.max(0, v);

/**
 * Découpe le Reste (total = RAM + swap utilisées) :
 * - others : somme réelle des groupes hors top (`loadedOthersKB` si leurs séries sont chargées, sinon groupes − top) ;
 * - shmem : Shmem ;
 * - kernel : max(0, total − groupes − shmem), estimation basse (RSS double compté), null si un terme manque.
 * Jamais de valeur négative ni NaN ; une valeur inconnue donne une couche nulle (jamais inventée).
 */
export function splitRest(
  totalKB: number | null,
  topKB: number,
  groupsKB: number | null,
  shmemKB: number | null,
  loadedOthersKB?: number | null,
): RestSplit {
  const others = loadedOthersKB != null ? pos(loadedOthersKB) : groupsKB === null ? null : pos(groupsKB - topKB);
  const kernel = totalKB === null || groupsKB === null || shmemKB === null ? null : pos(totalKB - groupsKB - shmemKB);
  return { others, shmem: shmemKB, kernel };
}

/**
 * Courbes de l'enquête : les `n` plus gros groupes (par max), puis le Reste découpé en trois couches (autres groupes,
 * fichiers en mémoire, noyau et caches), en valeurs brutes (une courbe par couche, pas d'empilement). `totals` est
 * aligné sur `h.ts`. Si des séries hors top sont chargées, « Autres groupes » est leur somme ; sinon groupes − top.
 */
export function investigationSeries(h: GroupsHistory, n: number, totals: RestTotals) {
  const byKey = new Map(h.series.map((s) => [s.key, s.memKB]));
  const top = topKeysByMax(byKey, n);
  const topSet = new Set(top);
  const rest = h.series.filter((s) => !topSet.has(s.key));
  const split = h.ts.map((_, i) =>
    splitRest(
      totals.usedKB[i] ?? null,
      top.reduce((sum, k) => sum + (byKey.get(k)![i] ?? 0), 0),
      totals.groupsKB[i] ?? null,
      totals.shmemKB[i] ?? null,
      rest.length ? rest.reduce((sum, s) => sum + (s.memKB[i] ?? 0), 0) : null,
    ),
  );
  const layers = (['others', 'shmem', 'kernel'] as const).map((k) => ({ key: REST_KEYS[k], label: REST_LABELS[k], values: split.map((s) => s[k]) }));
  return {
    ts: h.ts,
    layers: [...top.map((k) => ({ key: k, label: h.series.find((s) => s.key === k)!.label, values: byKey.get(k)! })), ...layers],
  };
}

/** Valeurs des trois couches du Reste au point le plus proche de `ts` (null hors plage, à un pas près). */
export function breakdownAt(inv: { ts: number[]; layers: { key: string; values: (number | null)[] }[] }, ts: number): RestSplit | null {
  const n = inv.ts.length;
  if (n === 0) return null;
  const step = n > 1 ? inv.ts[1] - inv.ts[0] : 0;
  if (ts < inv.ts[0] - step || ts > inv.ts[n - 1] + step) return null;
  let best = 0;
  for (let i = 1; i < n; i++) if (Math.abs(inv.ts[i] - ts) < Math.abs(inv.ts[best] - ts)) best = i;
  const at = (key: string) => inv.layers.find((l) => l.key === key)?.values[best] ?? null;
  return { others: at(REST_KEYS.others), shmem: at(REST_KEYS.shmem), kernel: at(REST_KEYS.kernel) };
}

const COLORS: Record<string, string> = {
  earlyoom_kill: '#ff5c8a', pressure: '#ffb547', gap: '#8b91a0', app_kill: '#a07cff', leak: '#ff8a3d', tmpfs: REST_TONES.shmem, forecast: '#ffb547',
  rule_action: '#ff5c8a', rule_dry_run: '#8b91a0',
};

function label(e: HistoryEvent): string {
  const d = e.detail;
  switch (e.type) {
    case 'earlyoom_kill': return `Kill earlyoom : ${String(d.name ?? '?')}`;
    case 'pressure': return `Pression ${Math.round(Number(d.psi))} %`;
    case 'gap':
      if (d.reason !== undefined || d.backup !== undefined) return 'Base recréée';
      {
        const from = Number(d.from ?? NaN);
        const to = Number(d.to ?? NaN);
        if (!Number.isFinite(from) || !Number.isFinite(to)) return "Trou d'enregistrement";
        return `Trou d'enregistrement (${Math.round((to - from) / 60_000)} min)`;
      }
    case 'app_kill': return 'Kill depuis proc-watch';
    case 'leak': return `Fuite probable : ${e.groupLabel ?? '?'} +${formatKB(Number(d.growthKB))}`;
    case 'tmpfs': return `Fichiers en mémoire : ${formatKB(Number(d.shmemKB))}`;
    case 'forecast': {
      const eta = Number(d.etaMin);
      if (!Number.isFinite(eta)) return 'Épuisement de la mémoire prévu';
      return eta < 1 ? "Épuisement prévu dans moins d'une minute" : `Épuisement prévu dans ~${Math.round(eta)} min`;
    }
    case 'rule_action':
    case 'rule_dry_run':
      return ruleEventText(e.type, d).title;
    default: return e.type;
  }
}

export function eventMarkers(events: HistoryEvent[]) {
  return events.map((e) => ({ ts: e.ts, type: e.type, color: COLORS[e.type] ?? '#8b91a0', label: label(e) }));
}

export function alertsFrom(events: HistoryEvent[]): HistoryEvent[] {
  return events.filter((e) => e.type !== 'app_kill').sort((a, b) => b.ts - a.ts);
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** Instant à la seconde : « HH:mm:ss » si c'est le jour de `now`, « dd/MM HH:mm:ss » sinon. */
export function formatInstant(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const hms = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  return d.toDateString() === new Date(now).toDateString() ? hms : `${p2(d.getDate())}/${p2(d.getMonth() + 1)} ${hms}`;
}

/** Nombre de groupes nommés dans l'enquête (le reste forme les trois couches du Reste). */
export const INVESTIGATION_LAYERS = 8;

interface MetricsApi {
  system: (r: TimeRange) => Promise<SystemSeries | null>;
  top: (r: TimeRange, o?: TopOptions) => Promise<TopResult>;
  events: (r: TimeRange) => Promise<HistoryEvent[]>;
  groups: (r: TimeRange, keys?: string[]) => Promise<GroupsHistory | null>;
}

/**
 * Données de l'onglet sur une plage explicite (mêmes buckets partout). Les couches de l'enquête sont les groupes
 * au plus haut pic de la plage — un pic court mais énorme y figure — ; la liste « Top » reste classée par moyenne.
 */
export async function fetchMetrics(h: MetricsApi, r: TimeRange) {
  // un seul appel : les deux classements sortent du même parcours de la base
  const [system, top, events] = await Promise.all([h.system(r), h.top(r, { peakLimit: INVESTIGATION_LAYERS }), h.events(r)]);
  const groups = top.byMax.length ? await h.groups(r, top.byMax.map((t) => t.key)) : null;
  return { system, top: top.byAvg, events, groups };
}

const AUTO_REFRESH_MS = 30_000;

/** Rafraîchissement automatique : toutes les 30 s jusqu'à 24 h ; jamais pour 7 j / 30 j (bouton « Actualiser ») ni en zoom. */
export function refreshMsFor(preset: RangePreset, zoomed: boolean): number | null {
  return zoomed || preset === '7d' || preset === '30d' ? null : AUTO_REFRESH_MS;
}

const H = 3_600_000;
/** Durée de chaque plage prédéfinie. */
export const PRESET_MS: Record<RangePreset, number> = { '1h': H, '6h': 6 * H, '24h': 24 * H, '7d': 7 * 24 * H, '30d': 30 * 24 * H };

const WHEEL_FACTOR = 1.25;

/** Garde `[from, from + span]` dans les bornes en le décalant (la largeur ne change pas). */
function clampWindow(from: number, span: number, bounds: TimeRange): TimeRange {
  const f = Math.min(Math.max(from, bounds.from), bounds.to - span);
  return { from: f, to: f + span };
}

/**
 * Ctrl + molette : zoom de 25 % par cran centré sur `anchor` (l'instant sous la souris reste sous la souris).
 * Jamais plus court que `minMs` ; `null` quand on dézoome jusqu'à la plage complète (retour à la plage choisie).
 */
export function wheelZoom(view: TimeRange, bounds: TimeRange, anchor: number, deltaY: number, minMs: number): TimeRange | null {
  if (deltaY === 0) return view;
  const span = view.to - view.from;
  const full = bounds.to - bounds.from;
  const next = Math.max(minMs, Math.min(full, deltaY < 0 ? span / WHEEL_FACTOR : span * WHEEL_FACTOR));
  if (next >= full) return null;
  const ratio = span > 0 ? (anchor - view.from) / span : 0.5;
  return clampWindow(Math.round(anchor - ratio * next), Math.round(next), bounds);
}

/** Maj + molette : déplace la fenêtre zoomée de 10 % de sa largeur par cran, sans sortir des bornes ; `null` si pas de zoom. */
export function wheelPan(view: TimeRange, bounds: TimeRange, delta: number): TimeRange | null {
  const span = view.to - view.from;
  if (span >= bounds.to - bounds.from) return null;
  const shift = Math.max(-span, Math.min(span, (span * 0.1 * delta) / 100));
  return clampWindow(Math.round(view.from + shift), span, bounds);
}

/** Zoom mémorisé : largeur + bord droit ; `to: null` = collé au bout, la fenêtre suit le direct. */
export interface ZoomState { span: number; to: number | null }

/** Au plus 60 s (ou 2 % de la fenêtre) du bout : considéré « au bout ». */
const EDGE_TOLERANCE_MS = 60_000;

export function toZoom(view: TimeRange, now: number): ZoomState {
  const span = view.to - view.from;
  const tol = Math.max(EDGE_TOLERANCE_MS, span * 0.02);
  return { span, to: now - view.to <= tol ? null : view.to };
}

export function zoomRange(z: ZoomState, now: number): TimeRange {
  const to = z.to ?? now;
  return { from: to - z.span, to };
}

/** Bouton molette maintenu : la fenêtre suit la souris (glisser à droite = remonter le temps) ; `null` sans zoom. */
export function dragPan(view: TimeRange, bounds: TimeRange, dxPx: number, widthPx: number): TimeRange | null {
  const span = view.to - view.from;
  if (span >= bounds.to - bounds.from) return null;
  if (widthPx <= 0) return view;
  return clampWindow(Math.round(view.from - (dxPx / widthPx) * span), span, bounds);
}
