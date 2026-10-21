// Anti-gel : plafonds de cwatch.slice (pur, sans import Node).
import { RESERVE_MAX_MB, RESERVE_MIN_MB } from './config';

export const MiB = 1024 * 1024;
export const GiB = 1024 * MiB;
const PAGE = 4096;
/** « infinity » d'une propriété mémoire systemd (type `t` de D-Bus) : UINT64_MAX. */
export const INFINITY_T = '18446744073709551615';

export interface SliceLimits { reserveBytes: number; highBytes: number; maxBytes: number; swapMaxBytes: number }

const down = (n: number) => Math.floor(n / PAGE) * PAGE;

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
