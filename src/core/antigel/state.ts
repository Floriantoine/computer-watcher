// Anti-gel : état écrit par le service (antigel-state.json, 0600), lu par le main pour la fenêtre. Sans import Node.
import { normalizePath } from '../disk/projects';
import { isProdProjectSliceName } from './units';

export type AntigelStatus = 'active' | 'off' | 'unavailable';
export interface AntigelSliceState { currentKB: number; highKB: number | null; maxKB: number | null; swapMaxKB: number | null; throttles: number; oomKills: number }
/** `unit` : nom de la slice de projet (cwatch-p-<clé>.slice), qui porte le budget optionnel du projet. */
export interface AntigelProjectState { unit: string; root: string | null; procs: number; currentKB: number; budgetMB: number | null; throttled: boolean }
export interface AntigelState {
  version: 1;
  /** Horloge murale du tick qui a écrit l'état. */
  at: number;
  enabled: boolean;
  status: AntigelStatus;
  /** Indisponible : raison lisible (« contrôleur mémoire non délégué… »). */
  reason: string | null;
  memTotalKB: number;
  /** Réserve effective pour le bureau (actif seulement). */
  reserveKB: number | null;
  slice: AntigelSliceState | null;
  projects: AntigelProjectState[];
  /** Attribution slice de projet → racine de projet (relue au redémarrage du service). */
  scopes: Record<string, string | null>;
  lastError: string | null;
  /** Coût moyen de l'étape anti-gel d'un tick (ms, moyenne glissante). */
  tickMs: number;
  /** Appels busctl depuis le démarrage du service. */
  dbusCalls: number;
}

export const MAX_STATE_BYTES = 256 * 1024;
const MAX_TEXT = 300;
const MAX_ITEMS = 200;

const MAX_NUM = Number.MAX_SAFE_INTEGER;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_NUM;
const int = (v: unknown): v is number => num(v) && Number.isInteger(v);
const numOrNull = (v: unknown): v is number | null => v === null || num(v);
const text = (v: unknown): v is string | null => v === null || (typeof v === 'string' && v.length <= MAX_TEXT);
const root = (v: unknown): v is string | null => v === null || (typeof v === 'string' && v.length <= 1024 && !/[\x00-\x1f]/.test(v) && v.startsWith('/') && normalizePath(v) === v);

function slice(v: unknown): v is AntigelSliceState | null {
  if (v === null) return true;
  if (typeof v !== 'object' || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  return num(s.currentKB) && numOrNull(s.highKB) && numOrNull(s.maxKB) && numOrNull(s.swapMaxKB) && int(s.throttles) && int(s.oomKills);
}
function project(v: unknown): v is AntigelProjectState {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const p = v as Record<string, unknown>;
  return isProdProjectSliceName(p.unit) && root(p.root) && int(p.procs) && num(p.currentKB) && numOrNull(p.budgetMB) && typeof p.throttled === 'boolean';
}

// Reconstruction champ par champ : aucune propriété en plus (ni __proto__) ne traverse.
const copySlice = (v: AntigelSliceState): AntigelSliceState => ({ currentKB: v.currentKB, highKB: v.highKB, maxKB: v.maxKB, swapMaxKB: v.swapMaxKB, throttles: v.throttles, oomKills: v.oomKills });
const copyProject = (v: AntigelProjectState): AntigelProjectState => ({ unit: v.unit, root: v.root, procs: v.procs, currentKB: v.currentKB, budgetMB: v.budgetMB, throttled: v.throttled });

export function parseAntigelState(t: string): AntigelState | null {
  if (t.length > MAX_STATE_BYTES || new TextEncoder().encode(t).length > MAX_STATE_BYTES) return null;
  let o: unknown;
  try {
    o = JSON.parse(t);
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
  const s = o as Record<string, unknown>;
  if (s.version !== 1 || !num(s.at) || typeof s.enabled !== 'boolean') return null;
  if (s.status !== 'active' && s.status !== 'off' && s.status !== 'unavailable') return null;
  if (!text(s.reason) || !text(s.lastError) || !num(s.memTotalKB) || !numOrNull(s.reserveKB) || !num(s.tickMs) || !num(s.dbusCalls)) return null;
  if (!slice(s.slice)) return null;
  if (!Array.isArray(s.projects) || s.projects.length > MAX_ITEMS || !s.projects.every(project)) return null;
  if (typeof s.scopes !== 'object' || s.scopes === null || Array.isArray(s.scopes)) return null;
  const scopes = Object.entries(s.scopes as Record<string, unknown>);
  if (scopes.length > MAX_ITEMS || !scopes.every(([u, r]) => isProdProjectSliceName(u) && root(r))) return null;
  return {
    version: 1, at: s.at, enabled: s.enabled, status: s.status, reason: s.reason, memTotalKB: s.memTotalKB, reserveKB: s.reserveKB,
    slice: s.slice === null ? null : copySlice(s.slice), projects: s.projects.map(copyProject), scopes: Object.fromEntries(scopes) as Record<string, string | null>,
    lastError: s.lastError, tickMs: s.tickMs, dbusCalls: s.dbusCalls,
  };
}

export interface AntigelView { state: AntigelState | null; fresh: boolean }

/** `fresh` : écrit il y a moins de 3 intervalles du service (+ 5 s), pas plus de 5 s dans le futur. */
export function antigelView(t: string | null, now: number, intervalSec: number): AntigelView {
  const state = t === null ? null : parseAntigelState(t);
  if (!state) return { state: null, fresh: false };
  const age = now - state.at;
  return { state, fresh: age >= -5000 && age <= 3 * intervalSec * 1000 + 5000 };
}
