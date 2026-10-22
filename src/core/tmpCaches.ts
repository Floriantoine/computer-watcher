// Caches connus de /tmp (tmpfs : en RAM) qu'on peut vider en un clic : définitions pures, partagées par le main, le service
// et le renderer (sans import Node). Liste figée, vérifiée dans le code de chaque outil : il recrée seul son cache, et le
// vider ne perd rien (fichiers dérivés des sources). « Vider » supprime les fichiers et garde les dossiers (voir
// tmpCachesClean.ts). Exclus : tsx-<uid> (sockets IPC des processus tsx vivants), caches natifs (nx), inconnus.
import type { TmpCleanEvent } from './history/events';

export const TMP_CACHE_IDS = ['jest', 'node-compile-cache', 'v8-compile-cache', 'playwright-transform-cache'] as const;
export type TmpCacheId = (typeof TMP_CACHE_IDS)[number];

const DEFS: Record<TmpCacheId, { label: string; short: string; name: (uid: number) => string }> = {
  // jest-config : `${tmpdir()}/jest_${getuid().toString(36)}` ; recréé au lancement (createDirectory) et à chaque écriture
  jest: { label: 'Cache de transformation de Jest', short: 'Jest', name: (uid) => `jest_${uid.toString(36)}` },
  // Node ≥ 22 (module.enableCompileCache : npm, tsc…) : un sous-dossier par version ; écriture en échec ignorée en silence
  'node-compile-cache': { label: 'Cache de compilation de Node.js', short: 'Node.js', name: () => 'node-compile-cache' },
  // paquet v8-compile-cache (yarn 1, anciens ESLint, ts-node…) : relu au démarrage, réécrit à la sortie (mkdirp)
  'v8-compile-cache': { label: 'Cache de compilation (paquet v8-compile-cache)', short: 'v8-compile-cache', name: (uid) => `v8-compile-cache-${uid}` },
  // Playwright Test : `${tmpdir()}/playwright-transform-cache-${geteuid()}`, lecture en échec = recompilation
  'playwright-transform-cache': { label: 'Cache de transformation de Playwright Test', short: 'Playwright', name: (uid) => `playwright-transform-cache-${uid}` },
};

/** Nom de premier niveau du cache dans /tmp pour cet utilisateur (jamais un motif). */
export const tmpCacheName = (id: TmpCacheId, uid: number): string => DEFS[id].name(uid);
export const tmpCacheLabel = (id: TmpCacheId): string => DEFS[id].label;

/** Cache présent dans la racine : place occupée par ses fichiers (« au moins » si la mesure a été coupée), refus éventuel. */
export interface TmpCache {
  id: TmpCacheId;
  name: string;
  sizeKB: number;
  atLeast: boolean;
  /** Raison pour laquelle il n'est pas vidable (null : vidable). */
  refusal: string | null;
}

export interface TmpCaches {
  root: string;
  /** Caches présents seulement, dans l'ordre de TMP_CACHE_IDS. */
  caches: TmpCache[];
}

export interface TmpCacheResult {
  id: TmpCacheId;
  name: string;
  /** Tous les fichiers supprimés. */
  ok: boolean;
  freedKB: number;
  /** Une partie des fichiers seulement (temps écoulé, fichier impossible à supprimer…). */
  partial?: boolean;
  reason?: string;
}

export interface TmpCachesOutcome {
  results: TmpCacheResult[];
  freedKB: number;
}

const isId = (v: unknown): v is TmpCacheId => typeof v === 'string' && (TMP_CACHE_IDS as readonly string[]).includes(v);

/** Forme d'une demande `tmp:emptyCaches` : 1 à 4 identifiants connus, distincts (jamais un chemin ni un nom). */
export function isTmpCacheIds(v: unknown): v is TmpCacheId[] {
  return Array.isArray(v) && v.length > 0 && v.length <= TMP_CACHE_IDS.length && v.every(isId) && new Set(v).size === v.length;
}

/** Seuil du bouton de l'alerte et de la notification : en dessous, vider ne changerait rien à l'alerte. */
export const CACHE_OFFER_MIN_KB = 100 * 1024;

const fmtKB = (kb: number) => (kb >= 1024 * 1024 ? `${(kb / (1024 * 1024)).toFixed(1).replace('.', ',')} Go` : kb >= 1024 ? `${Math.round(kb / 1024)} Mo` : `${Math.round(kb)} Ko`);

/** Bouton « Vider les caches (X) » de l'alerte tmpfs : caches vidables, ensemble au moins CACHE_OFFER_MIN_KB ; sinon null. */
export function cachesOffer(c: TmpCaches | null): { ids: TmpCacheId[]; sizeKB: number; label: string } | null {
  const ok = (c?.caches ?? []).filter((x) => x.refusal === null && x.sizeKB > 0);
  const sizeKB = ok.reduce((s, x) => s + x.sizeKB, 0);
  if (sizeKB < CACHE_OFFER_MIN_KB) return null;
  const size = `${ok.some((x) => x.atLeast) ? 'au moins ' : ''}${fmtKB(sizeKB)}`;
  const label = ok.length === 1 ? `Vider le cache ${DEFS[ok[0].id].short} (${size})` : `Vider les caches (${size})`;
  return { ids: ok.map((x) => x.id), sizeKB, label };
}

/** Toast (app) et notification du résultat (service). */
export function cachesOutcomeMessage(o: TmpCachesOutcome): { message: string; kind: 'info' | 'error' } {
  if (!o.results.length) return { message: 'Aucun cache connu à vider', kind: 'info' };
  const bad = o.results.filter((r) => !r.ok);
  const freed = `${fmtKB(o.freedKB)} libérés`;
  if (!bad.length) {
    const n = o.results.length;
    return { message: n === 1 ? `Cache ${DEFS[o.results[0].id].short} vidé : ${freed}` : `${n} caches vidés : ${freed}`, kind: 'info' };
  }
  const why = bad.map((r) => `${r.name} (${r.reason ?? 'refusé'})`).join(', ');
  if (o.freedKB > 0 || bad.length < o.results.length) return { message: `Caches vidés en partie : ${freed} ; ${why}`, kind: 'error' };
  return { message: `Rien n’a été vidé : ${why}`, kind: 'error' };
}

/** Événement du journal (même type qu'une suppression dans /tmp) ; null si rien n'a été vidé, même en partie. */
export function tmpCachesEvent(o: TmpCachesOutcome, ts: number): TmpCleanEvent | null {
  const deleted = o.results.filter((r) => r.ok).map((r) => r.name);
  const partial = o.results.some((r) => r.partial);
  if (!deleted.length && !partial) return null;
  const refused = o.results.filter((r) => !r.ok).map((r) => ({ name: r.name, reason: r.reason ?? 'refusé' }));
  return { ts, type: 'tmp_clean', groupKey: null, detail: { freedKB: o.freedKB, deleted, refused, ...(partial ? { partial: true as const } : {}) } };
}

/** Conseil durable, sous la liste : un cache Jest sur disque ne pèse plus sur la RAM. */
export const JEST_CACHE_ADVICE =
  'Pour de bon : mettez le cache de Jest sur disque avec l’option cacheDirectory de la config Jest du projet (par exemple "<rootDir>/node_modules/.cache/jest").';
