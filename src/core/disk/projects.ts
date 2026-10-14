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
