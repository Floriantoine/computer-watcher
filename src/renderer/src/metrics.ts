import { stackSeries, topKeysByMax } from '../../core/history/series';
import type { GroupsHistory, HistoryEvent } from '../../core/types';
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
    case 'gap': return `Trou d'enregistrement (${Math.round((Number(d.to) - Number(d.from)) / 60_000)} min)`;
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
