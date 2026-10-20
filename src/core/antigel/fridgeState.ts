// Anti-gel (lot 3, « mettre au frigo ») : état publié dans antigel-state.json et demandes de la fenêtre. Sans import Node
// (sert aussi au renderer). Tout ce qui est relu est reconstruit champ par champ, borné, et les noms d'unités sont validés.
import { normalizePath } from '../disk/projects';
import { OTHERS_SLICE, isProdProjectSliceName } from './units';

/** freezing : FreezeUnit en cours ; reclaiming : gelé, mémoire poussée en swap ; frozen : au frigo ; thawing : réveil en cours. */
export type FridgePhase = 'freezing' | 'reclaiming' | 'frozen' | 'thawing';
export const FRIDGE_PHASES: readonly FridgePhase[] = ['freezing', 'reclaiming', 'frozen', 'thawing'];
/** `since` : horloge murale du gel ; `reclaimedKB` : mémoire sortie de la RAM par le reclaim (baisse de memory.current). */
export interface FridgeEntryState { unit: string; root: string; since: number; phase: FridgePhase; reclaimedKB: number }
/** Dernier résultat d'une demande (refus, échec, réussite), affiché par la fenêtre. */
export interface FridgeNotice { root: string; text: string; ok: boolean; at: number }
export type FridgeAction = 'freeze' | 'thaw';
export interface FridgeRequest { root: string; action: FridgeAction; at: number }

/** Projets au frigo en même temps, au plus. */
export const MAX_FROZEN = 20;
export const MAX_FRIDGE_REQUESTS = 16;
export const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_TEXT = 300;
const MAX_PATH = 1024;

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Racine de projet acceptée : chemin absolu normalisé, ni « / », sans caractère de contrôle, 1024 caractères au plus. */
export function fridgeRoot(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > MAX_PATH || !v.startsWith('/') || /[\x00-\x1f\x7f]/.test(v)) return null;
  return normalizePath(v) === v && v !== '/' ? v : null;
}

function entry(v: unknown): FridgeEntryState | null {
  if (!isObj(v)) return null;
  if (!isProdProjectSliceName(v.unit) || v.unit === OTHERS_SLICE) return null;
  const root = fridgeRoot(v.root);
  if (root === null || !num(v.since) || !num(v.reclaimedKB) || !FRIDGE_PHASES.includes(v.phase as FridgePhase)) return null;
  return { unit: v.unit, root, since: v.since, phase: v.phase as FridgePhase, reclaimedKB: v.reclaimedKB };
}

function notice(v: unknown): FridgeNotice | null | undefined {
  if (v === null) return null;
  if (!isObj(v)) return undefined;
  const root = fridgeRoot(v.root);
  if (root === null || typeof v.text !== 'string' || v.text.length > MAX_TEXT || typeof v.ok !== 'boolean' || !num(v.at)) return undefined;
  return { root, text: v.text, ok: v.ok, at: v.at };
}

/**
 * Champs `fridge` et `fridgeNotice` de l'état (facultatifs : un état du lot 1 reste valide). null : présents mais invalides
 * (l'état entier est alors refusé, comme pour les autres champs).
 */
export function parseFridgeFields(s: Record<string, unknown>): { fridge?: FridgeEntryState[]; fridgeNotice?: FridgeNotice | null } | null {
  const out: { fridge?: FridgeEntryState[]; fridgeNotice?: FridgeNotice | null } = {};
  if (s.fridge !== undefined) {
    if (!Array.isArray(s.fridge) || s.fridge.length > MAX_FROZEN) return null;
    const list = s.fridge.map(entry);
    if (list.some((e) => e === null)) return null;
    out.fridge = list as FridgeEntryState[];
  }
  if (s.fridgeNotice !== undefined) {
    const n = notice(s.fridgeNotice);
    if (n === undefined) return null;
    out.fridgeNotice = n;
  }
  return out;
}

function request(v: unknown): FridgeRequest | null {
  if (!isObj(v)) return null;
  const root = fridgeRoot(v.root);
  if (root === null || (v.action !== 'freeze' && v.action !== 'thaw') || !num(v.at)) return null;
  return { root, action: v.action, at: v.at };
}

/** Fichier de demandes : `{ version: 1, requests: [...] }` ; toute entrée invalide est écartée, au plus 16 gardées. */
export function parseFridgeRequests(text: string | null): FridgeRequest[] {
  if (text === null || text.length > MAX_REQUEST_BYTES) return [];
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isObj(o) || o.version !== 1 || !Array.isArray(o.requests)) return [];
  const out: FridgeRequest[] = [];
  for (const r of o.requests.slice(0, MAX_FRIDGE_REQUESTS)) {
    const x = request(r);
    if (x) out.push(x);
  }
  return out;
}

/** Ajoute une demande : une seule par racine (la dernière gagne), les 16 plus récentes gardées. */
export function mergeFridgeRequests(list: readonly FridgeRequest[], r: FridgeRequest): FridgeRequest[] {
  return [...list.filter((x) => x.root !== r.root), r].slice(-MAX_FRIDGE_REQUESTS);
}
