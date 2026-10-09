// Suppression d'éléments de premier niveau de /tmp (B1 bis) : règles pures partagées par le main et le renderer, sans import Node.

/** Au plus 50 éléments par demande de suppression. */
export const MAX_TMP_DELETE = 50;

/** Quarantaine d'un lot de suppression, dans la racine : jamais proposée (liste système), signalée si elle reste. */
export const TRASH_PREFIX = '.proc-watch-trash-';
/** Fichier témoin exigé dans une racine de test (PROC_WATCH_TMP_ROOT). */
export const TEST_ROOT_MARKER = '.proc-watch-test-root';

/** Élément de premier niveau tel qu'affiché ; `ino`/`dev` (décimaux, bigint) servent à vérifier que rien n'a changé. */
export interface TmpEntry {
  name: string;
  ino: string;
  dev: string;
  kind: 'dir' | 'file' | 'link';
  /** Place occupée (dossier : parcours « au moins » si partiel ; lien : le lien seul, jamais sa cible). */
  sizeKB: number;
  /** Cache connu, se reconstruit tout seul. */
  cache: boolean;
  /** Modifié il y a moins de 5 min : peut-être en cours d'utilisation. */
  recent: boolean;
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
  /** Suppression indisponible (ex. pas de GNU rm) : raison ; null sinon. */
  disabled: string | null;
  /** Quarantaines restées (suppressions interrompues), quelle que soit leur taille ; `eligible` : à nous, 0700 (vidables). */
  quarantines: { name: string; eligible: boolean }[];
}

export interface TmpDeleteItem {
  name: string;
  ino: string;
  dev: string;
}

export interface TmpDeleteResult {
  name: string;
  ok: boolean;
  reason?: string;
}

export interface TmpDeleteOutcome {
  results: TmpDeleteResult[];
  /** Place libérée (tailles de la dernière liste des éléments supprimés), en Ko. */
  freedKB: number;
  /** Refusé à la confirmation du main : rien n'a été touché. */
  cancelled?: boolean;
  /** Au moins un élément a pu être supprimé en partie (échec en cours de route) ; le reste est dans la quarantaine. */
  partial?: boolean;
}

/** Ce que la confirmation du main affiche. */
export interface TmpConfirmSummary {
  /** Suppression d'éléments (défaut) ou vidage des quarantaines restées. */
  purpose?: 'delete' | 'quarantine';
  root: string;
  items: { name: string; kind: TmpEntry['kind']; sizeKB: number; recent: boolean }[];
  totalKB: number;
  uninspectable: { pid: number; name: string }[];
  /** « Vider la quarantaine » : entrées de premier niveau de chaque quarantaine (`setAside` : mis à l'écart après un échange). */
  quarantines?: { name: string; entries: { name: string; kind: TmpEntry['kind']; sizeKB: number; atLeast?: boolean; setAside: boolean; unknown?: boolean }[]; more: number }[];
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
  /^claude-/,
  /^\.proc-watch-/, // quarantaines, fichier témoin, marques internes
  /^runtime-/,
  /^\.org\.chromium\./,
  /^snap-private-tmp$/,
  /^gpg-/,
  /^orbit-/,
];

/** Entrée gérée par le système ou la session (sockets X, ssh-agent, pulse, systemd, Claude Code…) : jamais supprimée. */
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

const isId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,20}$/.test(v);

/** Forme d'une demande `tmp:delete` : 1 à 50 éléments {name, ino, dev} (ino/dev décimaux). Les noms sont vérifiés élément par élément. */
export function isTmpDeleteRequest(v: unknown): v is TmpDeleteItem[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_TMP_DELETE) return false;
  return v.every((x: unknown) => {
    if (typeof x !== 'object' || x === null) return false;
    const o = x as Record<string, unknown>;
    return typeof o.name === 'string' && isId(o.ino) && isId(o.dev);
  });
}

/** Contrôle (C0, DEL, C1), sens d'écriture (bidi), invisibles et séparateurs de ligne : affichés échappés. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

/** Nom tel qu'affiché : les caractères qui feraient lire autre chose sont échappés (`\u{202e}`), et signalés. */
export function displayName(name: string): { text: string; escaped: boolean } {
  let escaped = false;
  const text = name.replace(UNSAFE, (c) => {
    escaped = true;
    return `\\u{${c.codePointAt(0)!.toString(16)}}`;
  });
  return { text, escaped };
}

/** Programmes souvent non vérifiables (droits élevés) : un élément qui porte leur nom est refusé. */
const KNOWN_UNINSPECTABLE = ['warp', 'kwin', 'polkit', 'xwayland', 'kde', 'plasma', 'kwallet'];

/**
 * Nom d'un processus non vérifiable qui utilise peut-être cet élément : le nom contient (sans casse) le comm d'un
 * processus non vérifiable (en préfixe seulement s'il fait moins de 4 caractères) ou un préfixe connu. Null sinon.
 */
export function suspectUser(name: string, uninspectable: { name: string }[]): string | null {
  const n = name.toLowerCase();
  for (const p of uninspectable) {
    const c = p.name.replace(/^\((.*)\)$/, '$1').toLowerCase();
    if (c.length < 2) continue;
    if (c.length >= 4 ? n.includes(c) : n.startsWith(c) && !/[a-z]/.test(n[c.length] ?? '')) return c;
  }
  return KNOWN_UNINSPECTABLE.find((k) => n.includes(k)) ?? null;
}
