// Anti-gel (lot 2) : état du bureau prioritaire publié dans antigel-state.json (sans import Node : lu aussi par le main).
import { isDeskSliceName, isDeskUnitName } from './deskUnits';
import { ROOT_SLICE } from './units';

export interface AntigelDeskState {
  status: 'active' | 'off' | 'unavailable';
  reason: string | null;
  /** Poids CPU posés (contrôleur cpu délégué). */
  cpu: boolean;
  /** Poids E/S posés (contrôleur io délégué). */
  io: boolean;
  /** Protection mémoire : posée, sans effet ici (niveaux système sans protection), ou non posée. */
  memory: 'on' | 'ineffective' | 'off';
  /** Unités réglées (bureau, terminaux, cwatch.slice). */
  units: string[];
  /** Plus de terminaux que la limite. */
  truncated: boolean;
  /** Unités qui attendent le retour à leurs valeurs d'origine. */
  restoring: number;
}

const MAX_UNITS = 32;
const isUnit = (u: unknown) => u === ROOT_SLICE || isDeskSliceName(u) || isDeskUnitName(u);

/** Reconstruction champ par champ ; null si invalide. */
export function parseDeskState(v: unknown): AntigelDeskState | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const d = v as Record<string, unknown>;
  if (d.status !== 'active' && d.status !== 'off' && d.status !== 'unavailable') return null;
  if (!(d.reason === null || (typeof d.reason === 'string' && d.reason.length <= 300))) return null;
  if (typeof d.cpu !== 'boolean' || typeof d.io !== 'boolean' || typeof d.truncated !== 'boolean') return null;
  if (d.memory !== 'on' && d.memory !== 'ineffective' && d.memory !== 'off') return null;
  if (!Array.isArray(d.units) || d.units.length > MAX_UNITS || !d.units.every(isUnit)) return null;
  if (!Number.isInteger(d.restoring) || (d.restoring as number) < 0 || (d.restoring as number) > 1000) return null;
  return {
    status: d.status, reason: d.reason, cpu: d.cpu, io: d.io, memory: d.memory, units: [...(d.units as string[])], truncated: d.truncated,
    restoring: d.restoring as number,
  };
}
