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
