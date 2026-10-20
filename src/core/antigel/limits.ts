// Anti-gel : plafonds de cwatch.slice (pur, sans import Node).
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
 * Plafonds de la slice : MemoryHigh = RAM − réserve (ralentit et récupère avant le gel), MemoryMax = RAM − réserve/2 (le
 * noyau tue dans la slice seulement), MemorySwapMax = 50 % du swap. null : RAM inconnue, ou moins de 1 Go laissé au travail.
 */
export function sliceLimits(memTotalKB: number, swapTotalKB: number, reserveMB: number | null): SliceLimits | null {
  if (!Number.isFinite(memTotalKB) || memTotalKB <= 0) return null;
  const total = memTotalKB * 1024;
  const reserve = reserveMB === null ? autoReserveBytes(total) : reserveMB * MiB;
  const high = down(total - reserve);
  if (high < GiB) return null;
  const swap = Number.isFinite(swapTotalKB) && swapTotalKB > 0 ? swapTotalKB * 1024 : 0;
  return { reserveBytes: reserve, highBytes: high, maxBytes: down(total - reserve / 2), swapMaxBytes: down(swap / 2) };
}

export function sameLimits(a: SliceLimits | null, b: SliceLimits | null): boolean {
  if (a === null || b === null) return a === b;
  return a.highBytes === b.highBytes && a.maxBytes === b.maxBytes && a.swapMaxBytes === b.swapMaxBytes;
}

export const budgetBytes = (mb: number): number => mb * MiB;
