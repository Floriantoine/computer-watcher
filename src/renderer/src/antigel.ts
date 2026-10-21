// Plafond de travail (anti-gel), fenêtre (logique pure) : marques des projets, carte Métriques, formulaires (Go).
import { BUDGET_MAX_MB, BUDGET_MIN_MB, RESERVE_MAX_MB, RESERVE_MIN_MB, budgetKey, effectiveBudget, type AntigelConfig } from '../../core/antigel/config';
import { MiB, autoReserveBytes } from '../../core/antigel/limits';
import type { FridgePhase } from '../../core/antigel/fridgeState';
import type { AntigelSliceState, AntigelState, AntigelView } from '../../core/antigel/state';
import { deskLine } from './antigelDesk';
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

/** Projet explicitement sans budget (le budget par défaut ne s'y applique pas) ou rendu au budget par défaut. */
export function withNoBudget(ag: AntigelConfig, root: string, on: boolean): AntigelConfig {
  const k = budgetKey(root);
  if (k === null) return ag;
  const list = (ag.noBudget ?? []).filter((r) => r !== k);
  if (on) list.push(k);
  const { noBudget: _, ...rest } = ag;
  return list.length ? { ...rest, noBudget: list } : rest;
}

/** Ligne de Réglages → budgets : budget explicite, budget par défaut, ou « sans budget » (mb null). */
export interface BudgetRow { root: string; mb: number | null; source: 'explicit' | 'default' | 'none' }

/**
 * Lignes de Réglages → budgets, triées : chaque budget explicite, chaque projet explicitement sans budget, et chaque
 * projet en cours sous le plafond (service actif, état frais) avec son budget effectif d'après la config.
 */
export function budgetRows(ag: AntigelConfig, v: AntigelView | null): BudgetRow[] {
  const roots = new Set<string>([...Object.keys(ag.budgets), ...(ag.noBudget ?? [])]);
  for (const p of active(v)?.projects ?? []) if (p.root !== null) roots.add(p.root);
  return [...roots].sort((a, b) => a.localeCompare(b)).map((root) => {
    const e = effectiveBudget(ag, root);
    return e === null ? { root, mb: null, source: 'none' } : { root, mb: e.mb, source: e.source };
  });
}

export const budgetLabel = (root: string): string => root.split('/').filter(Boolean).slice(-2).join(' / ');

export function reserveHint(memTotalKB: number | null): string {
  const auto = memTotalKB ? formatGo(Math.round(autoReserveBytes(memTotalKB * 1024) / MiB)) : 'max(4 Go, 15 % de la RAM)';
  return `Vide : automatique, ${auto}. Le travail est ralenti dès que la RAM disponible passe sous la réserve (au plus tard au-delà de RAM − réserve), et arrêté par le noyau seulement au-delà de RAM − réserve/2.`;
}

const plural = (n: number, w: string) => `${n} ${w}${n > 1 ? 's' : ''}`;
/** « N projets plafonnés » : la slice « autres » (vérifications hors projet, racine null) n'est pas un projet. */
function cappedLine(projects: readonly { root: string | null }[]): string {
  const n = projects.filter((p) => p.root !== null).length;
  const others = projects.some((p) => p.root === null);
  return `${plural(n, 'projet')} plafonné${n > 1 ? 's' : ''}${others ? ', plus des vérifications hors projet' : ''}`;
}

/** « Travail : 4,8 Go · marge avant ralentissement : 1,2 Go » (marge = plafond dynamique posé − travail actuel). */
function workText(sl: AntigelSliceState, word: string, sep: string): string {
  const head = `${word} : ${formatKB(sl.currentKB)}`;
  if (sl.highKB === null) return head;
  const margin = Math.max(0, sl.highKB - sl.currentKB);
  return `${head}${sep}marge avant ralentissement : ${margin > 0 ? formatKB(margin) : 'aucune'}`;
}

export function antigelStatusLine(v: AntigelView | null, enabled: boolean): string {
  if (!v || !v.state) return 'En attente du service d’enregistrement (c’est lui qui applique le plafond de travail).';
  if (!v.fresh) return 'Service d’enregistrement arrêté : plus aucun déplacement (les plafonds déjà posés restent).';
  const s = v.state;
  if (s.status === 'unavailable') return `Plafond de travail indisponible : ${s.reason ?? 'raison inconnue'}.`;
  if (s.status === 'off' || !enabled) return 'Éteint : aucun déplacement, plafonds levés.';
  return `Actif : ${cappedLine(s.projects)}${s.slice ? ` · ${workText(s.slice, 'travail', ', ')}` : ''}.`;
}

/** Infobulle de la mémoire hors budget : la limite des cgroups en une phrase, et le moyen de l'éviter. */
export const LATE_HINT =
  'Un processus capturé après son lancement laisse la mémoire déjà allouée comptée là où il a démarré (limite des cgroups) : lancez la commande avec « computer-watcher run -- <commande> » pour qu’elle soit dans le budget dès le départ.';

export interface LateLine { text: string; hint: string }

/** « 5,4 Go dans le budget · ~4,5 Go hors budget (capturé tard) » */
const usageText = (p: { currentKB: number; outsideKB?: number }) =>
  `${formatKB(p.currentKB)} dans le budget${p.outsideKB ? ` · ~${formatKB(p.outsideKB)} hors budget (capturé tard)` : ''}`;

type Proj = AntigelState['projects'][number];
/**
 * Freiné par son propre budget ? Un service d'avant ce lot ne publie pas `budgetThrottled` : un projet freiné avec un
 * budget l'est alors par son budget.
 */
const ownBrake = (p: Proj, rootBrake: boolean): boolean => p.budgetThrottled ?? (p.throttled && p.budgetMB !== null && !rootBrake);
/** Le plafond global freine-t-il ? Service d'avant ce lot : un projet sans budget freiné l'est par le plafond global. */
const rootBraking = (s: AntigelState): boolean => s.slice?.throttled ?? s.projects.some((p) => p.throttled && p.budgetMB === null);
/** « freiné en ce moment », « freiné 30 % de la dernière minute » ou « ok ». */
function brakeText(now: boolean, pct: number | undefined): string {
  if (now) return 'freiné en ce moment';
  return pct !== undefined && pct >= 1 ? `freiné ${pct} % de la dernière minute` : 'ok';
}
const label = (root: string | null) => (root === null ? 'Vérifications hors projet' : budgetLabel(root));

/** Réglages → budgets : mémoire du projet en cours (service actif et état frais), état du budget, hors budget s'il y en a. */
export function budgetUsage(v: AntigelView | null, root: string): { text: string; hint: string | null } | null {
  const s = active(v);
  const p = s?.projects.find((x) => x.root === root);
  if (!s || !p) return null;
  const state = p.budgetMB !== null ? ` — ${brakeText(ownBrake(p, rootBraking(s)), p.stallPct)}` : '';
  const late = p.outsideKB ? ` · ~${formatKB(p.outsideKB)} hors budget (capturé tard)` : '';
  return { text: `${formatKB(p.currentKB)} dans le budget${state}${late}`, hint: p.outsideKB ? LATE_HINT : null };
}

export interface BudgetLine { text: string; hint: string | null; throttled: boolean }

/** « 5,0 / 5 Go » (unité commune omise à gauche), « 800 Mo / 5 Go ». */
function usedOfBudget(currentKB: number, budgetMB: number): string {
  const used = formatKB(currentKB);
  return `${used.endsWith(' Go') ? used.slice(0, -3) : used} / ${formatGo(budgetMB)}`;
}

export interface AntigelCardModel {
  tone: 'ok' | 'warn' | 'off' | 'na'; title: string; usedKB: number | null; highKB: number | null; maxKB: number | null; fillPercent: number | null; lines: string[];
  /** « Travail : 4,8 Go · marge avant ralentissement : 1,2 Go », et son infobulle (plafond dynamique, arrêt). */
  memLine: string | null;
  memHint: string | null;
  /** Une ligne par projet en cours qui a un budget (explicite, ou par défaut avec la mention) : « projet : 5,0 / 5 Go — freiné en ce moment ». */
  budgets: BudgetLine[];
  /** Projets sans budget dont une part de la mémoire est comptée ailleurs (capturés tard), avec l'infobulle. */
  late: LateLine[];
}

export function antigelCard(v: AntigelView | null): AntigelCardModel {
  const none = { usedKB: null, highKB: null, maxKB: null, fillPercent: null, memLine: null, memHint: null, budgets: [], late: [] };
  if (!v || !v.state) return { tone: 'na', title: 'Plafond de travail : en attente du service d’enregistrement', ...none, lines: ['Le service d’enregistrement applique le plafond de travail ; il ne tourne pas ou n’a pas encore écrit son état.'] };
  if (!v.fresh) return { tone: 'na', title: 'Plafond de travail : service d’enregistrement arrêté', ...none, lines: ['Les plafonds déjà posés restent en place ; aucun nouveau processus n’est déplacé.'] };
  const s = v.state;
  if (s.status === 'unavailable') return { tone: 'na', title: `Plafond de travail indisponible : ${s.reason ?? 'raison inconnue'}`, ...none, lines: [] };
  if (s.status === 'off') return { tone: 'off', title: 'Plafond de travail éteint', ...none, lines: ['Réglages → Plafond de travail pour le rallumer.'] };
  const sl = s.slice;
  // ce qui freine vraiment : le plafond global (RAM presque pleine) ou le budget d'un projet
  const rootBrake = rootBraking(s);
  const own = s.projects.filter((p) => p.budgetMB !== null && ownBrake(p, rootBrake));
  const title = rootBrake
    ? 'Le travail est freiné : la RAM est presque pleine'
    : own.length === 1
      ? `Le projet ${label(own[0]!.root)} est freiné par son budget`
      : own.length > 1
        ? `${own.length} projets sont freinés par leur budget`
        : 'Plafond de travail actif';
  const rootLine = rootBrake
    ? `Travail freiné en ce moment${sl?.stallPct ? ` (${sl.stallPct} % de la dernière minute)` : ''}`
    : sl?.stallPct
      ? `Travail freiné ${sl.stallPct} % de la dernière minute`
      : null;
  const oom = sl?.oomKills ? `${plural(sl.oomKills, 'arrêt')} par le noyau sous le plafond` : null;
  return {
    tone: rootBrake || own.length > 0 ? 'warn' : 'ok',
    title,
    usedKB: sl?.currentKB ?? null,
    highKB: sl?.highKB ?? null,
    maxKB: sl?.maxKB ?? null,
    fillPercent: sl && sl.highKB ? Math.min(100, Math.round((100 * sl.currentKB) / sl.highKB)) : null,
    memLine: sl ? workText(sl, 'Travail', ' · ') : null,
    memHint: sl && sl.highKB !== null
      ? `Ralenti au-delà de ${formatKB(sl.highKB)} : ce plafond suit la RAM que le reste (navigateurs, bureau) laisse au-dessus de la réserve, au plus RAM − réserve.${sl.maxKB !== null ? ` Arrêt par le noyau seulement au-delà de ${formatKB(sl.maxKB)}.` : ''}`
      : null,
    lines: [
      cappedLine(s.projects),
      ...[rootLine, oom].filter((l): l is string => l !== null),
      ...(deskLine(s.desk) ? [deskLine(s.desk)!] : []),
      ...[fridgeCardLine(v)].filter((l): l is string => l !== null),
    ],
    budgets: s.projects
      .filter((p) => p.budgetMB !== null)
      .map((p) => {
        const now = ownBrake(p, rootBrake);
        const late = p.outsideKB ? ` · ~${formatKB(p.outsideKB)} hors budget (capturé tard)` : '';
        const def = p.budgetDefault ? ' (par défaut)' : '';
        return { text: `${label(p.root)} : ${usedOfBudget(p.currentKB, p.budgetMB!)}${def} — ${brakeText(now, p.stallPct)}${late}`, hint: p.outsideKB ? LATE_HINT : null, throttled: now };
      }),
    late: s.projects
      .filter((p) => p.outsideKB && p.budgetMB === null)
      .map((p) => ({ text: `${label(p.root)} : ${usageText(p)}`, hint: LATE_HINT })),
  };
}
