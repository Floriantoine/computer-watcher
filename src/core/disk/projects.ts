// Page Disque, lot 2 (pur) : dossiers de projets (réglage et défaut), verdict d'inactivité des node_modules.
// Sans import Node : utilisé aussi par le renderer (Réglages).

export const MAX_PROJECT_ROOTS = 20;
const MAX_PATH = 1024;

/** Chemin normalisé (« . », « .. », « / » répétés ou final), sans accès au disque. */
export function normalizePath(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

/** Réglage `ui.diskProjectRoots` : chemins absolus, normalisés, sans doublon, jamais « / » ; null si refusé. */
export function normalizeProjectRoots(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > MAX_PROJECT_ROOTS) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || !x.startsWith('/') || x.length > MAX_PATH || x.includes('\0')) return null;
    const n = normalizePath(x);
    if (n === '/') return null;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

export const DAY_MS = 86_400_000;

/** Dossiers jamais lus pour juger de l'activité d'un projet (dépendances, git, sorties de build, caches). */
export const SOURCE_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.vite', '.cache', 'coverage', 'target', '__pycache__',
  '.venv', 'venv', '.worktrees', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.svelte-kit', '.angular', '.parcel-cache',
]);

const under = (p: string, dir: string) => p.startsWith(`${dir}/`);

/**
 * Défaut de `ui.diskProjectRoots` : dossiers parents des racines de projets vues dans l'historique, sous HOME, jamais HOME
 * lui-même ni un chemin qui passe par un dossier caché (~/.cache, .worktrees…), existants, sans dossiers imbriqués.
 */
export function defaultProjectRoots(projectDirs: readonly string[], home: string, exists: (p: string) => boolean): string[] {
  const h = normalizePath(home);
  const parents = new Set<string>();
  for (const raw of projectDirs) {
    const p = normalizePath(raw);
    if (!under(p, h)) continue;
    const parent = p.slice(0, p.lastIndexOf('/'));
    if (!under(parent, h)) continue; // projet directement sous HOME : HOME n'est jamais un défaut
    if (parent.slice(h.length + 1).split('/').some((s) => s.startsWith('.'))) continue;
    parents.add(parent);
  }
  const list = [...parents].filter(exists).sort();
  return list.filter((p) => !list.some((q) => q !== p && under(p, q))).slice(0, MAX_PROJECT_ROOTS);
}

/** Dernier instant où un processus a été vu dans ce projet, un de ses sous-projets ou un dossier parent. */
export function lastSeenFor(projectDir: string, seen: ReadonlyMap<string, number>): number | null {
  let best: number | null = null;
  for (const [root, ts] of seen) {
    if (root === projectDir || under(root, projectDir) || under(projectDir, root)) best = best === null ? ts : Math.max(best, ts);
  }
  return best;
}

export interface NodeModulesFacts { lastSeen: number | null; newestMtime: number | null | 'budget'; historyFrom: number | null; now: number; days: number }
export type NodeModulesVerdict = { inactive: true; partialHistory: boolean } | { inactive: false; reason: string };

/**
 * Inactif : aucun processus vu dans le projet depuis `days` jours (historique) et aucun fichier source modifié depuis.
 * Historique plus court que la période (ou absent) : jugé sur ce qu'il couvre et sur les fichiers, marqué « partiel ».
 */
export function nodeModulesVerdict(f: NodeModulesFacts): NodeModulesVerdict {
  const since = f.now - f.days * DAY_MS;
  if (f.lastSeen !== null && f.lastSeen >= since) return { inactive: false, reason: `processus vu il y a ${Math.max(0, Math.floor((f.now - f.lastSeen) / DAY_MS))} j` };
  if (f.newestMtime === 'budget') return { inactive: false, reason: 'trop de fichiers pour juger' };
  if (f.newestMtime !== null && f.newestMtime >= since) return { inactive: false, reason: `fichier modifié il y a moins de ${f.days} j` };
  return { inactive: true, partialHistory: f.historyFrom === null || f.historyFrom > since };
}
