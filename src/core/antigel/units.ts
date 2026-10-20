// Anti-gel : noms d'unités systemd générés et validés (pur, sans import Node).
export const ROOT_SLICE = 'cwatch.slice';
export const OTHERS_SCOPE = 'cwatch-p-autres.scope';
export const SCOPE_RE = /^cwatch-p-[a-z0-9-]{1,48}\.scope$/;
/** Slice racine : cwatch.slice (service) ou cwatch-e2e<id>.slice (e2e, rangée sous cwatch.slice). */
export const SLICE_RE = /^cwatch(-e2e[a-z0-9]{1,16})?\.slice$/;
export const TEST_SLICE_RE = /^cwatch-e2e[a-z0-9]{1,16}\.slice$/;
export const TEST_SCOPE_RE = /^cwatch-p-e2e[a-z0-9]{1,16}\.scope$/;

export const isScopeName = (s: unknown): s is string => typeof s === 'string' && SCOPE_RE.test(s);
export const isSliceName = (s: unknown): s is string => typeof s === 'string' && SLICE_RE.test(s);

/** Chemin de la slice sous le gestionnaire utilisateur : un « - » crée une hiérarchie (cwatch-e2e1.slice → cwatch.slice/cwatch-e2e1.slice). */
export function slicePath(slice: string): string {
  if (!isSliceName(slice)) throw new Error(`slice refusée : ${slice}`);
  return slice === ROOT_SLICE ? ROOT_SLICE : `${ROOT_SLICE}/${slice}`;
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
 * Scope d'un projet (root null : vérifications hors projet → cwatch-p-autres.scope). `taken` : unités déjà attribuées
 * (unité → racine). Suffixe -<hash> seulement en cas de collision : même slug pour une autre racine, projet nommé
 * « autres », ou slug en « e2e… » (réservé aux scopes de l'e2e).
 */
export function scopeNameFor(root: string | null, taken: ReadonlyMap<string, string | null>): string {
  if (root === null) return OTHERS_SCOPE;
  for (const [unit, r] of taken) if (r === root) return unit;
  const slug = slugOf(root);
  const plain = `cwatch-p-${slug}.scope`;
  if (plain !== OTHERS_SCOPE && !slug.startsWith('e2e') && !taken.has(plain)) return plain;
  return `cwatch-p-${slug}-${shortHash(root)}.scope`;
}
