// Plafond de travail (anti-gel), fenêtre (logique pure) : marques des projets, carte Métriques, formulaires (Go).
import { BUDGET_MAX_MB, BUDGET_MIN_MB, RESERVE_MAX_MB, RESERVE_MIN_MB, budgetKey } from '../../core/antigel/config';
import { MiB, autoReserveBytes } from '../../core/antigel/limits';
import type { FridgePhase } from '../../core/antigel/fridgeState';
import type { AntigelView } from '../../core/antigel/state';
import { fridgeCardLine } from './fridge';
import { formatKB } from './format';

/** `frozen` (lot 3) : phase du frigo, absente si le projet n'y est pas. */
export interface AntigelMark { throttled: boolean; budgetMB: number | null; frozen?: FridgePhase }

const active = (v: AntigelView | null) => (v && v.fresh && v.state && v.state.status === 'active' ? v.state : null);

export function antigelMarks(v: AntigelView | null): Map<string, AntigelMark> {
  const out = new Map<string, AntigelMark>();
  const s = active(v);
  if (!s) return out;
  for (const p of s.projects) {
    if (p.root === null) continue;
    const id = `project:${p.root}`;
    const prev = out.get(id);
    out.set(id, { throttled: (prev?.throttled ?? false) || p.throttled, budgetMB: prev?.budgetMB ?? p.budgetMB });
  }
  for (const e of s.fridge ?? []) {
    const m = out.get(`project:${e.root}`);
    if (m) m.frozen = e.phase;
  }
  return out;
}

export const sameMark = (a?: AntigelMark, b?: AntigelMark): boolean =>
  a === b || (!!a && !!b && a.throttled === b.throttled && a.budgetMB === b.budgetMB && a.frozen === b.frozen);

export function parseGo(text: string): number | null | undefined {
  const t = text.trim().replace(/\s*go$/i, '').replace(',', '.');
  if (t === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return undefined;
  return Math.round(Number(t) * 1024);
}

export function formatGoInput(mb: number): string {
  return String(Math.round((mb / 1024) * 100) / 100).replace('.', ',');
}
export const formatGo = (mb: number): string => `${formatGoInput(mb)} Go`;

export function validateBudget(text: string): { ok: true; mb: number } | { ok: false; error: string } {
  const mb = parseGo(text);
  if (mb === null || mb === undefined) return { ok: false, error: 'Nombre de Go attendu, par exemple 6 ou 6,5.' };
  if (mb < BUDGET_MIN_MB || mb > BUDGET_MAX_MB) return { ok: false, error: `Entre ${formatGo(BUDGET_MIN_MB)} et ${formatGo(BUDGET_MAX_MB)}.` };
  return { ok: true, mb };
}

export function validateReserve(text: string, memTotalKB: number | null): { ok: true; mb: number | null } | { ok: false; error: string } {
  const mb = parseGo(text);
  if (mb === null) return { ok: true, mb: null };
  if (mb === undefined) return { ok: false, error: 'Nombre de Go attendu, par exemple 5 ou 4,5 ; vide : automatique.' };
  if (mb < RESERVE_MIN_MB || mb > RESERVE_MAX_MB) return { ok: false, error: `Entre ${formatGo(RESERVE_MIN_MB)} et ${formatGo(RESERVE_MAX_MB)}.` };
  if (memTotalKB && mb * 1024 > memTotalKB - 1024 * 1024) {
    return { ok: false, error: `Laisse au moins 1 Go au travail (RAM : ${formatGo(Math.floor(memTotalKB / 1024))}).` };
  }
  return { ok: true, mb };
}

export function withBudget(budgets: Record<string, number>, root: string, mb: number | null): Record<string, number> {
  const out = { ...budgets };
  const k = budgetKey(root);
  if (k === null) return out;
  if (mb === null) delete out[k];
  else out[k] = mb;
  return out;
}

export const budgetLabel = (root: string): string => root.split('/').filter(Boolean).slice(-2).join(' / ');

export function reserveHint(memTotalKB: number | null): string {
  const auto = memTotalKB ? formatGo(Math.round(autoReserveBytes(memTotalKB * 1024) / MiB)) : 'max(4 Go, 15 % de la RAM)';
  return `Vide : automatique, ${auto}. Le travail est ralenti au-delà de RAM − réserve et arrêté par le noyau au-delà de RAM − réserve/2.`;
}

const plural = (n: number, w: string) => `${n} ${w}${n > 1 ? 's' : ''}`;
/** « N projets plafonnés » : la slice « autres » (vérifications hors projet, racine null) n'est pas un projet. */
function cappedLine(projects: readonly { root: string | null }[]): string {
  const n = projects.filter((p) => p.root !== null).length;
  const others = projects.some((p) => p.root === null);
  return `${plural(n, 'projet')} plafonné${n > 1 ? 's' : ''}${others ? ', plus des vérifications hors projet' : ''}`;
}

export function antigelStatusLine(v: AntigelView | null, enabled: boolean): string {
  if (!v || !v.state) return 'En attente du service d’enregistrement (c’est lui qui applique le plafond de travail).';
  if (!v.fresh) return 'Service d’enregistrement arrêté : plus aucun déplacement (les plafonds déjà posés restent).';
  const s = v.state;
  if (s.status === 'unavailable') return `Plafond de travail indisponible : ${s.reason ?? 'raison inconnue'}.`;
  if (s.status === 'off' || !enabled) return 'Éteint : aucun déplacement, plafonds levés.';
  const high = s.slice?.highKB ?? null;
  return `Actif : ${cappedLine(s.projects)}${high !== null ? `, travail ralenti au-delà de ${formatKB(high)}` : ''}.`;
}

export interface AntigelCardModel { tone: 'ok' | 'warn' | 'off' | 'na'; title: string; usedKB: number | null; highKB: number | null; maxKB: number | null; fillPercent: number | null; lines: string[] }

export function antigelCard(v: AntigelView | null): AntigelCardModel {
  const none = { usedKB: null, highKB: null, maxKB: null, fillPercent: null };
  if (!v || !v.state) return { tone: 'na', title: 'Plafond de travail : en attente du service d’enregistrement', ...none, lines: ['Le service d’enregistrement applique le plafond de travail ; il ne tourne pas ou n’a pas encore écrit son état.'] };
  if (!v.fresh) return { tone: 'na', title: 'Plafond de travail : service d’enregistrement arrêté', ...none, lines: ['Les plafonds déjà posés restent en place ; aucun nouveau processus n’est déplacé.'] };
  const s = v.state;
  if (s.status === 'unavailable') return { tone: 'na', title: `Plafond de travail indisponible : ${s.reason ?? 'raison inconnue'}`, ...none, lines: [] };
  if (s.status === 'off') return { tone: 'off', title: 'Plafond de travail éteint', ...none, lines: ['Réglages → Plafond de travail pour le rallumer.'] };
  const sl = s.slice;
  const throttled = s.projects.some((p) => p.throttled);
  return {
    tone: throttled ? 'warn' : 'ok',
    title: throttled ? 'Plafond de travail atteint : travail ralenti' : 'Plafond de travail actif',
    usedKB: sl?.currentKB ?? null,
    highKB: sl?.highKB ?? null,
    maxKB: sl?.maxKB ?? null,
    fillPercent: sl && sl.highKB ? Math.min(100, Math.round((100 * sl.currentKB) / sl.highKB)) : null,
    lines: [
      cappedLine(s.projects),
      `${plural(sl?.throttles ?? 0, 'ralentissement')} · ${plural(sl?.oomKills ?? 0, 'arrêt')} par le noyau sous le plafond`,
      ...[fridgeCardLine(v)].filter((l): l is string => l !== null),
    ],
  };
}
