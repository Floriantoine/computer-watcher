// Anti-gel : plafonds de cwatch.slice et des slices de projet (pur, sans import Node).
import { RESERVE_MAX_MB, RESERVE_MIN_MB } from './config';

export const MiB = 1024 * 1024;
export const GiB = 1024 * MiB;
const PAGE = 4096;
/** « infinity » d'une propriété mémoire systemd (type `t` de D-Bus) : UINT64_MAX. */
export const INFINITY_T = '18446744073709551615';

export interface SliceLimits { reserveBytes: number; highBytes: number; maxBytes: number; swapMaxBytes: number }

const down = (n: number) => Math.floor(n / PAGE) * PAGE;
const up = (n: number) => Math.ceil(n / PAGE) * PAGE;

/** Réserve automatique pour le bureau : max(4 Go, 15 % de la RAM). */
export function autoReserveBytes(memTotalBytes: number): number {
  return Math.max(4 * GiB, Math.round(0.15 * memTotalBytes));
}

/**
 * Plafonds statiques de la slice : MemoryHigh = RAM − réserve (borne haute du plafond dynamique, voir dynamicHigh),
 * MemoryMax = RAM − réserve/2 (le noyau tue dans la slice seulement), MemorySwapMax = 50 % du swap. null : RAM inconnue,
 * ou moins de 1 Go laissé au travail.
 */
export function sliceLimits(memTotalKB: number, swapTotalKB: number, reserveMB: number | null): SliceLimits | null {
  if (!Number.isFinite(memTotalKB) || memTotalKB <= 0) return null;
  if (reserveMB !== null && !(Number.isFinite(reserveMB) && reserveMB >= RESERVE_MIN_MB && reserveMB <= RESERVE_MAX_MB)) return null;
  const total = memTotalKB * 1024;
  const reserve = reserveMB === null ? autoReserveBytes(total) : reserveMB * MiB;
  const high = down(total - reserve);
  if (high < GiB) return null;
  const swap = Number.isFinite(swapTotalKB) && swapTotalKB > 0 ? swapTotalKB * 1024 : 0;
  const limits = { reserveBytes: reserve, highBytes: high, maxBytes: down(total - reserve / 2), swapMaxBytes: down(swap / 2) };
  return Object.values(limits).every(Number.isFinite) ? limits : null;
}

export function sameLimits(a: SliceLimits | null, b: SliceLimits | null): boolean {
  if (a === null || b === null) return a === b;
  return a.highBytes === b.highBytes && a.maxBytes === b.maxBytes && a.swapMaxBytes === b.swapMaxBytes;
}

/**
 * Plancher du plafond dynamique : 1 Go, le minimum que sliceLimits laisse déjà au travail (et que Réglages impose à la
 * réserve). En dessous, une RAM pleine hors travail étranglerait le moindre outil (git, tsc d'un petit projet) au point de
 * le geler ; le bureau reste alors défendu par la réserve basse (bureau prioritaire) et par earlyoom.
 */
export const DYN_FLOOR_BYTES = GiB;
/** Hystérésis : le plafond posé n'est réécrit que si l'écart dépasse max(256 Mo, 5 %) (sauf borne atteinte). */
export const DYN_MIN_STEP_BYTES = 256 * MiB;
export const DYN_MIN_STEP_RATIO = 0.05;

/**
 * MemoryHigh dynamique de cwatch.slice : travail actuel (memory.current) + max(0, MemAvailable − réserve), entre le
 * plancher et le plafond statique (RAM − réserve). Travail + MemAvailable ≈ RAM − mémoire du reste (navigateurs,
 * bureau…) : le plafond suit ce que le reste laisse vraiment, sans bouger quand le travail lui-même grossit ou libère.
 * Il n'est jamais posé sous la mémoire actuelle du travail (hors bornes) : il arrête la croissance, sans reprise brutale.
 * MemAvailable ou travail illisible : plafond statique.
 */
export function dynamicHigh(l: SliceLimits, workBytes: number, availKB: number | null): number {
  if (availKB === null || !Number.isFinite(availKB) || availKB < 0 || !Number.isFinite(workBytes) || workBytes < 0) return l.highBytes;
  const floor = Math.min(DYN_FLOOR_BYTES, l.highBytes);
  const want = workBytes + Math.max(0, availKB * 1024 - l.reserveBytes);
  return down(Math.max(floor, Math.min(l.highBytes, want)));
}

/**
 * Plafonds à poser : MemoryHigh dynamique, MemoryMax et MemorySwapMax statiques. `applied` (plafonds déjà posés) est
 * renvoyé tel quel si seul MemoryHigh bouge de moins de max(256 Mo, 5 %) sans atteindre une borne : pas de
 * SetUnitProperties pour quelques Mo.
 */
export function dynamicLimits(l: SliceLimits, o: { workBytes: number; availKB: number | null }, applied: SliceLimits | null): SliceLimits {
  const high = dynamicHigh(l, o.workBytes, o.availKB);
  const next = { ...l, highBytes: high };
  if (applied === null || applied.maxBytes !== l.maxBytes || applied.swapMaxBytes !== l.swapMaxBytes || applied.reserveBytes !== l.reserveBytes) return next;
  if (applied.highBytes === high) return applied;
  const bound = high === l.highBytes || high === Math.min(DYN_FLOOR_BYTES, l.highBytes);
  const step = Math.max(DYN_MIN_STEP_BYTES, DYN_MIN_STEP_RATIO * applied.highBytes);
  return !bound && Math.abs(high - applied.highBytes) < step && applied.highBytes <= l.highBytes ? applied : next;
}

export const budgetBytes = (mb: number): number => mb * MiB;

/**
 * Plafonds de la slice d'un projet qui a un budget : MemoryHigh = budget (au-delà, sa mémoire est poussée vers le swap
 * puis freinée), MemorySwapMax = sa part de swap (il ne remplit plus le swap de tout le système), MemoryMax = plafond dur
 * (au-delà, le noyau arrête le plus gros processus de CETTE slice, jamais ailleurs ; scopes en OOMPolicy=continue).
 * Mémoire comptée à la slice (RAM + swap) : au plus MemoryMax + MemorySwapMax.
 */
export interface ProjectCaps { highBytes: number; maxBytes: number; swapMaxBytes: number }
/** Part de swap d'un projet et marge du plafond dur au-dessus du budget : 25 % du budget chacune. */
export const PROJECT_SWAP_RATIO = 0.25;
export const PROJECT_MARGIN_RATIO = 0.25;
/** Marge minimale du plafond dur (petits budgets) : un pic d'un processus ne fait pas arrêter le projet. */
export const PROJECT_MIN_MARGIN_BYTES = 512 * MiB;

/** Budget (Mo) → plafonds : 5 Go → freine à 5 Go, swap 1,25 Go au plus, arrêt au-delà de 6,25 Go (7,5 Go au total). */
export function projectCaps(budgetMB: number): ProjectCaps {
  const high = down(budgetBytes(budgetMB));
  return {
    highBytes: high,
    maxBytes: high + Math.max(PROJECT_MIN_MARGIN_BYTES, down(PROJECT_MARGIN_RATIO * high)),
    swapMaxBytes: down(PROJECT_SWAP_RATIO * high),
  };
}

export function sameCaps(a: ProjectCaps | null, b: ProjectCaps | null): boolean {
  if (a === null || b === null) return a === b;
  return a.highBytes === b.highBytes && a.maxBytes === b.maxBytes && a.swapMaxBytes === b.swapMaxBytes;
}

/**
 * MemoryMax à poser sur la slice d'un projet. Écrire memory.max sous memory.current fait récupérer puis tuer aussitôt par
 * le noyau : le plafond dur n'est jamais posé à moins d'une marge (celle du budget) au-dessus de l'usage actuel. Au-dessus
 * du plafond visé, il ne remonte jamais (sinon il suivrait un projet qui grossit) ; il redescend avec l'usage par pas d'au
 * moins une marge (chaque écriture repose aussi MemoryHigh, que le noyau fait respecter aussitôt : peu d'appels), et d'un
 * coup jusqu'au plafond visé dès que l'usage le permet. Le remonter (budget relevé) ne tue jamais.
 * `applied` : MemoryMax en place (null : aucun) ; `currentBytes` : memory.current de la slice (0 si elle n'existe pas
 * encore ; illisible : rien ne descend).
 */
export function convergingMax(caps: ProjectCaps, currentBytes: number, applied: number | null): number {
  const target = caps.maxBytes;
  if (applied !== null && applied <= target) return target;
  if (!Number.isFinite(currentBytes) || currentBytes < 0) return applied ?? target;
  const margin = caps.maxBytes - caps.highBytes;
  const floor = up(currentBytes + margin);
  if (floor <= target) return target;
  if (applied === null) return floor;
  if (floor >= applied) return applied;
  return applied - floor >= margin ? floor : applied;
}
