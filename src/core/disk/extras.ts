// Page Disque, lot 2 : types échangés entre le main et le renderer (sans import Node).
import { isFamilyRequest, type FamilyId } from './families';
import { isDockerAction, type DockerAction, type DockerView } from './docker';

/** node_modules proposé (inactif) : trouvé par le main, seule sa clé `path` revient du renderer. */
export interface NodeModulesCandidate {
  path: string;
  /** Racine du projet (dépôt git, sinon package.json le plus proche) : activité jugée là. */
  projectDir: string;
  label: string;
  sizeKB: number | null;
  lastSeen: number | null;
  /** Historique plus court que le seuil : jugé surtout sur les fichiers. */
  partialHistory: boolean;
}

/** Worktree fusionné : `refusal` non nul → affiché, case désactivée (modifications, fichiers ignorés à garder, trop récent…). */
export interface WorktreeCandidate {
  path: string;
  /** Worktree principal du dépôt : git y est lancé (worktree remove, branch -d). */
  repo: string;
  branch: string;
  /** Commit au moment de l'analyse : un nouveau commit annule la proposition. */
  head: string;
  label: string;
  sizeKB: number | null;
  refusal: string | null;
}

/** Dossier inconnu de ~/.cache : seule sa clé `name` revient du renderer. */
export interface CacheDirCandidate { name: string; path: string; sizeKB: number | null; refusal: string | null }

/** Requête de ménage du renderer : ids de familles et clés d'éléments trouvés par la dernière analyse du main. */
export interface DiskCleanRequest { families: FamilyId[]; nodeModules: string[]; worktrees: string[]; cacheDirs: string[]; docker: DockerAction[] }

const KEYS = ['families', 'nodeModules', 'worktrees', 'cacheDirs', 'docker'];
const strList = (v: unknown, max: number, ok: (s: string) => boolean) =>
  Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.length <= 4096 && !x.includes('\0') && ok(x)) && new Set(v).size === v.length;

export function isDiskCleanRequest(v: unknown): v is DiskCleanRequest {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (Object.keys(r).length !== KEYS.length || !KEYS.every((k) => k in r)) return false;
  const fams = r.families;
  if (!Array.isArray(fams) || (fams.length > 0 && !isFamilyRequest(fams))) return false;
  const abs = (s: string) => s.startsWith('/');
  const name = (s: string) => s.length > 0 && s.length <= 255 && !s.includes('/') && s !== '.' && s !== '..';
  if (!strList(r.nodeModules, 500, abs) || !strList(r.worktrees, 200, abs) || !strList(r.cacheDirs, 200, name)) return false;
  const dock = r.docker;
  if (!Array.isArray(dock) || dock.length > 3 || !dock.every(isDockerAction) || new Set(dock).size !== dock.length) return false;
  return fams.length + (r.nodeModules as unknown[]).length + (r.worktrees as unknown[]).length + (r.cacheDirs as unknown[]).length + dock.length > 0;
}

/** Refus levé par une action juste avant d'agir : rien n'a été supprimé (le ménage n'ajoute pas « une partie a pu être supprimée »). */
export class NothingRemovedError extends Error {
  override name = 'NothingRemovedError';
}

export const requestFromFamilies = (ids: FamilyId[]): DiskCleanRequest => ({ families: ids, nodeModules: [], worktrees: [], cacheDirs: [], docker: [] });

/** Résultat d'un ménage : `id` = id de famille, ou clé `node_modules:<chemin>`, `worktree:<chemin>`, `cache:<nom>`, `docker:<action>`. */
export interface DiskCleanAllResult {
  freedKB: number;
  estimatedKB?: number;
  done: string[];
  refused: { id: string; label: string; reason: string }[];
  notes: { id: string; label: string; note: string }[];
  cancelled: boolean;
}

/** Dernière analyse (projets, ~/.cache, Docker) envoyée au renderer. */
export interface ExtrasView {
  at: number;
  days: number;
  home: string;
  projectRoots: { roots: string[]; isDefault: boolean; missing: string[] };
  nodeModules: NodeModulesCandidate[];
  worktrees: WorktreeCandidate[];
  projectErrors: string[];
  truncated: boolean;
  gitMissing: boolean;
  cacheDirs: { dirs: CacheDirCandidate[]; refusal: string | null };
  docker: DockerView | null;
}
