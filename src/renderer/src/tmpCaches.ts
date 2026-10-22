// Caches connus de /tmp (section de la page /tmp, bouton du pop-up d'alerte) : lignes, « Tout vider », conseil Jest.
import { tmpCacheLabel, type TmpCacheId, type TmpCaches } from '../../core/tmpCaches';
import { formatKB } from './format';

export interface CacheRow {
  id: TmpCacheId;
  name: string;
  label: string;
  /** « 5,3 Go », « au moins 2,0 Go », « vide », ou « — » (refusé : pas mesuré). */
  size: string;
  refusal: string | null;
  /** Vidable : aucun refus et quelque chose à libérer. */
  canEmpty: boolean;
}

export function cacheRows(c: TmpCaches | null): CacheRow[] {
  return (c?.caches ?? []).map((x) => ({
    id: x.id,
    name: x.name,
    label: tmpCacheLabel(x.id),
    size: x.refusal !== null ? '—' : x.sizeKB === 0 && !x.atLeast ? 'vide' : `${x.atLeast ? 'au moins ' : ''}${formatKB(x.sizeKB)}`,
    refusal: x.refusal,
    canEmpty: x.refusal === null && x.sizeKB > 0,
  }));
}

/** « Tout vider (X) » : au moins deux caches vidables ; sinon le bouton de la ligne suffit. */
export function emptyAllAction(c: TmpCaches | null): { ids: TmpCacheId[]; label: string } | null {
  const ok = (c?.caches ?? []).filter((x) => x.refusal === null && x.sizeKB > 0);
  if (ok.length < 2) return null;
  return { ids: ok.map((x) => x.id), label: `Tout vider (${ok.some((x) => x.atLeast) ? 'au moins ' : ''}${formatKB(ok.reduce((s, x) => s + x.sizeKB, 0))})` };
}

/** Conseil « cacheDirectory » : seulement quand le cache Jest est dans /tmp. */
export const showJestAdvice = (c: TmpCaches | null): boolean => !!c?.caches.some((x) => x.id === 'jest');
