// Familles récupérables de la page Disque (lot 1, pur) : liste fermée, chemins recalculés depuis HOME / XDG, versions de
// navigateurs de test à garder, estimation du cache pacman. Le renderer n'envoie jamais que des ids de cette liste.
// Sans import Node : utilisé aussi par le renderer (libellés, badges).

const join = (a: string, b: string) => `${a.replace(/\/+$/, '')}/${b}`;
const isAbsolute = (p: string) => p.startsWith('/');

export type FamilyId = 'npm' | 'pnpm' | 'yarn' | 'uv' | 'pip' | 'cargo' | 'paru' | 'yay' | 'test-browsers' | 'trash' | 'pkg-cache' | 'journal';

export interface FamilyDef {
  id: FamilyId;
  label: string;
  badge: 'rebuild' | 'root' | 'keep-latest';
  root: boolean;
  /**
   * Outils propres à la famille : l'un d'eux en cours (par nom, /proc/<pid>/comm) → famille refusée. Les processus plus
   * généraux (node, python, navigateurs) ne comptent que s'ils ont un cwd, un fd ou un mmap dans les chemins.
   */
  processNames: readonly string[];
}

export const FAMILIES: readonly FamilyDef[] = [
  { id: 'npm', label: 'Cache npm', badge: 'rebuild', root: false, processNames: ['npm', 'npx'] },
  { id: 'pnpm', label: 'Magasin pnpm', badge: 'rebuild', root: false, processNames: ['pnpm'] },
  { id: 'yarn', label: 'Cache Yarn', badge: 'rebuild', root: false, processNames: ['yarn'] },
  { id: 'uv', label: 'Cache uv', badge: 'rebuild', root: false, processNames: ['uv'] },
  { id: 'pip', label: 'Cache pip', badge: 'rebuild', root: false, processNames: ['pip', 'pip3'] },
  { id: 'cargo', label: 'Registre Cargo', badge: 'rebuild', root: false, processNames: ['cargo', 'rustc'] },
  { id: 'paru', label: 'Cache paru', badge: 'rebuild', root: false, processNames: ['paru', 'makepkg'] },
  { id: 'yay', label: 'Cache yay', badge: 'rebuild', root: false, processNames: ['yay', 'makepkg'] },
  { id: 'test-browsers', label: 'Navigateurs de test (anciennes versions)', badge: 'keep-latest', root: false, processNames: ['playwright', 'headless_shell'] },
  { id: 'trash', label: 'Corbeille', badge: 'rebuild', root: false, processNames: [] },
  { id: 'pkg-cache', label: 'Cache de paquets', badge: 'root', root: true, processNames: ['pacman', 'paru', 'yay', 'makepkg', 'apt', 'apt-get', 'dpkg'] },
  { id: 'journal', label: 'Journaux systemd', badge: 'root', root: true, processNames: [] },
];

export const FAMILY_IDS: readonly FamilyId[] = FAMILIES.map((f) => f.id);
export const familyDef = (id: FamilyId): FamilyDef => FAMILIES.find((f) => f.id === id)!;
export const isFamilyId = (v: unknown): v is FamilyId => typeof v === 'string' && (FAMILY_IDS as readonly string[]).includes(v);

/** Requête du renderer : 1 à 12 ids connus, sans doublon. */
export function isFamilyRequest(v: unknown): v is FamilyId[] {
  return Array.isArray(v) && v.length >= 1 && v.length <= FAMILY_IDS.length && v.every(isFamilyId) && new Set(v).size === v.length;
}

export interface FamilyRoots { home: string; configHome: string; dataHome: string; cacheHome: string }

/** Racines XDG (variable seulement si chemin absolu, comme la spécification XDG). */
export function familyRoots(env: NodeJS.ProcessEnv, home: string): FamilyRoots {
  const x = (k: string, d: string) => {
    const v = env[k];
    return v && isAbsolute(v) ? v : join(home, d);
  };
  return { home, configHome: x('XDG_CONFIG_HOME', '.config'), dataHome: x('XDG_DATA_HOME', '.local/share'), cacheHome: x('XDG_CACHE_HOME', '.cache') };
}

/** Racines système des familles root (lecture seule pour la mesure ; la suppression passe par le script figé). */
export const PKG_CACHE_DIRS = ['/var/cache/pacman/pkg', '/var/cache/apt/archives'] as const;
export const JOURNAL_DIR = '/var/log/journal';

/** Chemins d'une famille, recalculés dans le main depuis son id. test-browsers : dossiers de base (versions dedans). */
export function familyPaths(id: FamilyId, r: FamilyRoots): string[] {
  switch (id) {
    case 'npm': return [join(r.home, '.npm/_cacache')];
    case 'pnpm': return [join(r.dataHome, 'pnpm/store')];
    case 'yarn': return [join(r.cacheHome, 'yarn')];
    case 'uv': return [join(r.cacheHome, 'uv')];
    case 'pip': return [join(r.cacheHome, 'pip')];
    case 'cargo': return [join(r.home, '.cargo/registry/cache'), join(r.home, '.cargo/registry/src'), join(r.home, '.cargo/git/checkouts')];
    case 'paru': return [join(r.cacheHome, 'paru')];
    case 'yay': return [join(r.cacheHome, 'yay')];
    case 'test-browsers': return [join(r.cacheHome, 'ms-playwright'), join(r.cacheHome, 'puppeteer')];
    case 'trash': return [join(r.dataHome, 'Trash/files'), join(r.dataHome, 'Trash/info')];
    case 'pkg-cache': return [...PKG_CACHE_DIRS];
    case 'journal': return [JOURNAL_DIR];
  }
}

const VERSIONED = /^(.+)-(\d+(?:\.\d+)*)$/;
const cmpDotted = (a: string, b: string) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/**
 * Versions à retirer dans un dossier de navigateurs (`chromium-1140`, `linux-131.0.6778.85`) : par préfixe, toutes sauf
 * le numéro le plus élevé. Un nom sans version numérique n'est jamais retiré.
 */
export function browserVersionsToDrop(names: readonly string[]): string[] {
  const byPrefix = new Map<string, { name: string; v: string }[]>();
  for (const name of names) {
    const m = VERSIONED.exec(name);
    if (!m || name.startsWith('.')) continue;
    byPrefix.set(m[1], [...(byPrefix.get(m[1]) ?? []), { name, v: m[2] }]);
  }
  const out: string[] = [];
  for (const list of byPrefix.values()) {
    list.sort((a, b) => cmpDotted(b.v, a.v));
    out.push(...list.slice(1).map((x) => x.name));
  }
  return out;
}

/** Segments alternés chiffres / lettres (rpmvercmp simplifié) : chiffres comparés en nombre, et toujours plus récents que des lettres. */
function cmpSegments(a: string, b: string): number {
  const sa = a.match(/\d+|[A-Za-z]+/g) ?? [];
  const sb = b.match(/\d+|[A-Za-z]+/g) ?? [];
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const x = sa[i];
    const y = sb[i];
    if (x === undefined) return y !== undefined && /^\d/.test(y) ? -1 : 1; // « 1.0 » < « 1.0.1 » ; « 1.0a » < « 1.0 »
    if (y === undefined) return /^\d/.test(x) ? 1 : -1;
    const dx = /^\d/.test(x);
    const dy = /^\d/.test(y);
    if (dx && dy) {
      const d = Number(x) - Number(y);
      if (d) return d;
    } else if (dx !== dy) return dx ? 1 : -1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Comparaison de versions pacman simplifiée : époque (`1:`), version, release (`-n`). */
export function vercmp(a: string, b: string): number {
  const parse = (s: string) => {
    const e = /^(\d+):(.*)$/.exec(s);
    const epoch = e ? Number(e[1]) : 0;
    const rest = e ? e[2] : s;
    const i = rest.lastIndexOf('-');
    return { epoch, ver: i < 0 ? rest : rest.slice(0, i), rel: i < 0 ? '' : rest.slice(i + 1) };
  };
  const x = parse(a);
  const y = parse(b);
  if (x.epoch !== y.epoch) return x.epoch - y.epoch;
  return cmpSegments(x.ver, y.ver) || (x.rel && y.rel ? cmpSegments(x.rel, y.rel) : 0);
}

const PKG = /^(.+)-([^-]+)-([^-]+)-([^-]+)\.pkg\.tar(?:\.[a-z0-9]+)?$/;

/** Place libérée par `paccache -rk<keep>` : tout sauf les `keep` versions les plus récentes de chaque paquet (et arch). */
export function pacmanReclaimKB(files: readonly { name: string; sizeKB: number }[], keep: number): number {
  const pkgs = new Map<string, Map<string, number>>();
  for (const f of files) {
    const m = PKG.exec(f.name.replace(/\.sig$/, ''));
    if (!m) continue;
    const key = `${m[1]}\u0000${m[4]}`;
    const version = `${m[2]}-${m[3]}`;
    const versions = pkgs.get(key) ?? new Map<string, number>();
    versions.set(version, (versions.get(version) ?? 0) + f.sizeKB);
    pkgs.set(key, versions);
  }
  let total = 0;
  for (const versions of pkgs.values()) {
    const sorted = [...versions].sort((a, b) => vercmp(b[0], a[0]));
    for (const [, kb] of sorted.slice(keep)) total += kb;
  }
  return total;
}

export interface FamilyMeasure { id: FamilyId; sizeKB: number | null; reclaimKB: number | null; at: number; error?: string }
export interface FamiliesFile { at: number; families: FamilyMeasure[] }

/** Raison de refus affichée : « utilisé par npm (pid 1234) ». */
export const usedByText = (h: { pid: number; name: string }) => `utilisé par ${h.name} (pid ${h.pid})`;
