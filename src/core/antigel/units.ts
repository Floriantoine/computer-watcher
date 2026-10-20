// Anti-gel : noms d'unités systemd générés et validés (pur, sans import Node).
//
// Hiérarchie (amendement A1) :
//   cwatch.slice                          plafond global (MemoryHigh/MemoryMax/MemorySwapMax)
//   └ cwatch-p.slice                      implicite (créée par systemd à cause du « - »)
//     └ cwatch-p-<clé>.slice              une slice par projet (budget MemoryHigh facultatif)
//       └ cwatch-p-<clé>-<n>.scope        un scope neuf par lot de déplacement
// La clé ne contient jamais de « - » : il créerait un niveau de hiérarchie (le budget d'un autre projet s'appliquerait).
export const ROOT_SLICE = 'cwatch.slice';
/** Clé du « projet » des vérifications hors projet. */
export const OTHERS_KEY = 'autres';
export const OTHERS_SLICE = `cwatch-p-${OTHERS_KEY}.slice`;

const KEY = '[a-z0-9]{1,40}(?:_[0-9a-f]{6})?';
export const PROJECT_SLICE_RE = new RegExp(`^cwatch-p-${KEY}\\.slice$`);
export const SCOPE_RE = new RegExp(`^cwatch-p-${KEY}-[a-z0-9]{1,12}\\.scope$`);
/** Unités de l'e2e seulement : hors de « cwatch-p- », donc jamais confondues avec un projet. */
export const TEST_SLICE_RE = /^cwatch-e2e[a-z0-9]{1,16}\.slice$/;
export const TEST_PROJECT_SLICE_RE = /^cwatch-e2e[a-z0-9]{1,16}-[a-z0-9]{1,16}\.slice$/;
export const TEST_SCOPE_RE = /^cwatch-e2e[a-z0-9]{1,16}-[a-z0-9]{1,16}\.scope$/;
const SCOPE_N_RE = /^[a-z0-9]{1,12}$/;

const str = (s: unknown, re: RegExp): s is string => typeof s === 'string' && re.test(s);
/** cwatch.slice ou slice de test racine (les seules à porter MemoryMax / MemorySwapMax). */
export const isRootSliceName = (s: unknown): s is string => s === ROOT_SLICE || str(s, TEST_SLICE_RE);
export const isProjectSliceName = (s: unknown): s is string => str(s, PROJECT_SLICE_RE) || str(s, TEST_PROJECT_SLICE_RE);
/** Slice de projet de production seulement (état relu au redémarrage : jamais un nom de test). */
export const isProdProjectSliceName = (s: unknown): s is string => str(s, PROJECT_SLICE_RE);
export const isScopeName = (s: unknown): s is string => str(s, SCOPE_RE) || str(s, TEST_SCOPE_RE);
export const isTestUnitName = (s: unknown): s is string => str(s, TEST_SLICE_RE) || str(s, TEST_PROJECT_SLICE_RE) || str(s, TEST_SCOPE_RE);
const isAnySlice = (s: unknown): s is string => isRootSliceName(s) || isProjectSliceName(s);

/** Préfixe des scopes d'une slice de projet (« cwatch-p-<clé>- » ; en test « cwatch-e2e<id>- »). */
function scopePrefix(projectSlice: string): string {
  if (!isProjectSliceName(projectSlice)) throw new Error(`slice de projet refusée : ${projectSlice}`);
  const base = projectSlice.slice(0, -'.slice'.length);
  return PROJECT_SLICE_RE.test(projectSlice) ? `${base}-` : `${base.slice(0, base.indexOf('-', 'cwatch-e2e'.length))}-`;
}

/** Nom d'un scope neuf (n : [a-z0-9]{1,12}, unique) sous la slice de projet. */
export function newScopeName(projectSlice: string, n: string): string {
  if (!SCOPE_N_RE.test(n)) throw new Error(`numéro de scope refusé : ${n}`);
  const name = `${scopePrefix(projectSlice)}${n}.scope`;
  if (!isScopeName(name)) throw new Error(`scope refusé : ${name}`);
  return name;
}

/** Le scope appartient-il à cette slice de projet (même préfixe) ? */
export function scopeBelongs(scope: string, projectSlice: string): boolean {
  return isScopeName(scope) && scope.startsWith(scopePrefix(projectSlice));
}

/** Chemin de la slice sous le gestionnaire utilisateur (algorithme de systemd : a-b-c.slice → a.slice/a-b.slice/a-b-c.slice). */
export function slicePath(slice: string): string {
  if (!isAnySlice(slice)) throw new Error(`slice refusée : ${slice}`);
  const parts = slice.slice(0, -'.slice'.length).split('-');
  return parts.map((_, i) => `${parts.slice(0, i + 1).join('-')}.slice`).join('/');
}

/** Chemin du scope : sous sa slice de projet (le « - » du nom d'un scope ne crée pas de hiérarchie). */
export function scopePath(scope: string, slice: string): string {
  if (!scopeBelongs(scope, slice)) throw new Error(`scope refusé : ${scope}`);
  return `${slicePath(slice)}/${scope}`;
}

/** Empreinte courte (FNV-1a 32 bits, 6 chiffres hexadécimaux). */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) h = Math.imul(h ^ b, 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

/** Slug d'un projet : dernier composant, minuscules sans accents, [a-z0-9] seulement, 40 caractères au plus. */
export function slugOf(root: string): string {
  const base = root.replace(/\/+$/, '').split('/').pop() ?? '';
  const s = base.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
  return s || 'projet';
}

/**
 * Slice d'un projet (root null : vérifications hors projet → cwatch-p-autres.slice). `taken` : slices déjà attribuées
 * (slice → racine). Suffixe _<hash> (jamais « - ») seulement en cas de collision : même slug pour une autre racine,
 * ou projet nommé « autres ».
 */
export function projectSliceFor(root: string | null, taken: ReadonlyMap<string, string | null>): string {
  if (root === null) return OTHERS_SLICE;
  for (const [unit, r] of taken) if (r === root) return unit;
  const slug = slugOf(root);
  const plain = `cwatch-p-${slug}.slice`;
  if (plain !== OTHERS_SLICE && !taken.has(plain)) return plain;
  return `cwatch-p-${slug}_${shortHash(root)}.slice`;
}
