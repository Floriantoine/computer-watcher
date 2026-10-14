// Page Disque, lot 2 : types échangés entre le main et le renderer (sans import Node).

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
