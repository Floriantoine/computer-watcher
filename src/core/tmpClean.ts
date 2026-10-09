// Suppression d'éléments de premier niveau de /tmp (B1 bis) : règles pures partagées par le main et le renderer, sans import Node.

/** Au plus 50 éléments par demande de suppression. */
export const MAX_TMP_DELETE = 50;

/** Élément de premier niveau tel qu'affiché ; `ino`/`dev` servent à vérifier, juste avant de supprimer, que rien n'a changé. */
export interface TmpEntry {
  name: string;
  ino: number;
  dev: number;
  kind: 'dir' | 'file' | 'link';
  /** Place occupée (dossier : parcours « au moins » si partiel ; lien : le lien seul, jamais sa cible). */
  sizeKB: number;
  /** Cache connu, se reconstruit tout seul. */
  cache: boolean;
  /** Raison du refus (null : supprimable). */
  refusal: string | null;
}

export interface TmpListing {
  /** Racine listée (« /tmp », sauf racine de test). */
  root: string;
  entries: TmpEntry[];
  /** Parcours des tailles arrêté au plafond : tailles « au moins ». */
  truncated: boolean;
  /** Processus de l'utilisateur dont /proc est illisible (droits élevés) : leurs fichiers ouverts ne sont pas vérifiables. */
  uninspectable: { pid: number; name: string }[];
}

export interface TmpDeleteItem {
  name: string;
  ino: number;
  dev: number;
}

export interface TmpDeleteResult {
  name: string;
  ok: boolean;
  reason?: string;
}

export interface TmpDeleteOutcome {
  results: TmpDeleteResult[];
  /** Place libérée (taille mesurée de chaque élément supprimé juste avant sa suppression), en Ko. */
  freedKB: number;
}

/** Un seul composant de chemin : ni « / », ni NUL, ni « . » / « .. », ni vide, au plus 255 octets. */
export function isValidEntryName(name: string): boolean {
  if (name === '' || name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\0')) return false;
  return new TextEncoder().encode(name).length <= 255;
}

const SYSTEM: RegExp[] = [
  /^\.(X11|ICE|XIM|font|Test)-unix$/,
  /^systemd-private-/,
  /^\.mount_/,
  /^ssh-/,
  /^pulse-/,
  /^tracker-extract-/,
  /^krb5cc/,
  /^\.X\d*-lock$/,
  /^\.?xauth/i,
  /^kde-/,
  /^plasma-/,
  /^tmux-/,
  /^dbus-/,
  /^sddm-/,
];

/** Entrée gérée par le système ou la session (sockets X, ssh-agent, pulse, systemd…) : jamais supprimée. */
export const systemEntry = (name: string): boolean => SYSTEM.some((r) => r.test(name));

const CACHES: RegExp[] = [
  /^jest_/,
  /^node-compile-cache$/,
  /^v8-compile-cache-/,
  /^playwright-transform-cache-/,
  /^vite-/,
  /^\.babel/,
  /^ts-node-/,
  /^tsx-/,
];

/** Cache connu, qui se reconstruit tout seul. */
export const cacheLabel = (name: string): boolean => CACHES.some((r) => r.test(name));

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Forme d'une demande `tmp:delete` : 1 à 50 éléments {name: string, ino, dev entiers}. Les noms sont vérifiés élément par élément. */
export function isTmpDeleteRequest(v: unknown): v is TmpDeleteItem[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_TMP_DELETE) return false;
  return v.every((x: unknown) => {
    if (typeof x !== 'object' || x === null) return false;
    const o = x as Record<string, unknown>;
    return typeof o.name === 'string' && isId(o.ino) && isId(o.dev);
  });
}
