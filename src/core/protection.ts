/** Protégé d'après le nom du processus, ou son dossier de travail (`cwd`) s'il est dans un dossier de projet protégé. */
export type IsProtected = (name: string, cwd?: string | null) => boolean;

export interface Protection {
  isProtected: IsProtected;
  invalid: string[];
}

/**
 * Dossiers de projet protégés, tels que lus dans la config : chemins absolus, sans `/` final, jamais `/` seul (tout
 * serait protégé), sans doublon. Autre chose qu'un tableau → [] (jamais une raison de rejeter la config).
 */
export function normalizeProjectDirs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const x of raw) {
    if (typeof x !== 'string' || !x.startsWith('/')) continue;
    const dir = x.replace(/\/+$/, '');
    if (dir) out.add(dir);
  }
  return [...out];
}

/** `cwd` est `dir` ou un de ses sous-dossiers (`/p/L` ne couvre pas `/p/L2`). */
const isUnder = (cwd: string, dir: string) => cwd === dir || cwd.startsWith(`${dir}/`);

/**
 * Une entrée de nom est un nom exact, ou une regex écrite entre slashs : /^systemd/. `projects` : dossiers de projet
 * protégés (voir normalizeProjectDirs) ; tout processus qui y travaille est protégé, quel que soit son nom.
 */
export function compileProtection(entries: string[], projects: readonly string[] = []): Protection {
  const exact = new Set<string>();
  const regexes: RegExp[] = [];
  const invalid: string[] = [];
  for (const entry of entries) {
    const m = entry.match(/^\/(.+)\/$/);
    if (!m) {
      exact.add(entry);
      continue;
    }
    try {
      regexes.push(new RegExp(m[1]));
    } catch {
      invalid.push(entry);
    }
  }
  const dirs = normalizeProjectDirs(projects);
  return {
    isProtected: (name, cwd) =>
      exact.has(name) || regexes.some((r) => r.test(name)) || (!!cwd && dirs.some((d) => isUnder(cwd, d))),
    invalid,
  };
}
