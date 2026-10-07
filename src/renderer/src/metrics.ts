import { stackSeries, topKeysByMax } from '../../core/history/series';
import type { GroupsHistory, HistoryEvent, SystemSeries, TimeRange, TopConsumer, TopOptions } from '../../core/types';
import { formatKB } from './format';

/**
 * Couches de l'enquête : les `n` plus gros groupes (par max) + « Reste », valeurs cumulées prêtes à empiler.
 * Sans `totalKB`, le Reste est la somme des autres séries de `h`. Avec `totalKB` (mémoire utilisée du système,
 * alignée sur `h.ts`), le Reste vaut `total − top n` (borné à 0) : on peut alors ne charger que les plus gros groupes.
 */
export function investigationSeries(h: GroupsHistory, n = 8, totalKB?: (number | null)[]) {
  const byKey = new Map(h.series.map((s) => [s.key, s.memKB]));
  const top = topKeysByMax(byKey, n);
  const topSet = new Set(top);
  const rest = h.ts.map((_, i) => {
    if (totalKB) {
      const total = totalKB[i];
      if (total == null) return 0;
      return Math.max(0, top.reduce((left, k) => left - (byKey.get(k)![i] ?? 0), total));
    }
    return h.series.filter((s) => !topSet.has(s.key)).reduce((sum, s) => sum + (s.memKB[i] ?? 0), 0);
  });
  const raw = [...top.map((k) => byKey.get(k)!), rest];
  const stacked = stackSeries(raw);
  const labels = [...top.map((k) => h.series.find((s) => s.key === k)!.label), 'Reste'];
  const keys = [...top, '__rest'];
  return { ts: h.ts, layers: stacked.map((values, i) => ({ key: keys[i], label: labels[i], values, raw: raw[i] })) };
}

const COLORS: Record<string, string> = { earlyoom_kill: '#ff5c8a', pressure: '#ffb547', gap: '#8b91a0', app_kill: '#a07cff', leak: '#ff8a3d' };

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

/** Nombre de groupes nommés dans l'enquête (le reste forme la couche « Reste »). */
export const INVESTIGATION_LAYERS = 8;

interface MetricsApi {
  system: (r: TimeRange) => Promise<SystemSeries | null>;
  top: (r: TimeRange, o?: TopOptions) => Promise<TopConsumer[]>;
  events: (r: TimeRange) => Promise<HistoryEvent[]>;
  groups: (r: TimeRange, keys?: string[]) => Promise<GroupsHistory | null>;
}

/**
 * Données de l'onglet sur une plage explicite (mêmes buckets partout). Les couches de l'enquête sont les groupes
 * au plus haut pic de la plage — un pic court mais énorme y figure — ; la liste « Top » reste classée par moyenne.
 */
export async function fetchMetrics(h: MetricsApi, r: TimeRange) {
  const [system, top, peaks, events] = await Promise.all([h.system(r), h.top(r), h.top(r, { by: 'max', limit: INVESTIGATION_LAYERS }), h.events(r)]);
  const groups = peaks.length ? await h.groups(r, peaks.map((t) => t.key)) : null;
  return { system, top, events, groups };
}
