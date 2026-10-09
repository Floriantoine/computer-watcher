import { displayName, type TmpDeleteItem, type TmpDeleteOutcome, type TmpEntry, type TmpListing } from '../../core/tmpClean';
import type { TmpFsStats } from '../../core/types';
import { formatKB } from './format';

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;


/** Toast après une suppression : « n éléments supprimés, X libérés, k refusés : nom (raison), … ». */
export function tmpCleanMessage(o: TmpDeleteOutcome): { message: string; kind: 'info' | 'error' } {
  if (o.cancelled) return { message: 'Suppression annulée : rien n’a été touché', kind: 'info' };
  const ok = o.results.filter((r) => r.ok).length;
  const refused = o.results.filter((r) => !r.ok);
  let message = `${plural(ok, 'élément supprimé', 'éléments supprimés')}, ${formatKB(Math.round(o.freedKB))} libérés`;
  if (refused.length) message += `, ${plural(refused.length, 'refusé', 'refusés')} : ${refused.map((r) => `${r.name} (${r.reason ?? 'refusé'})`).join(', ')}`;
  if (o.partial) message = `Suppression partielle — ${message}`;
  return { message, kind: refused.length ? 'error' : 'info' };
}

/** Éléments cochés et encore supprimables (une ligne refusée ne part jamais), leur taille et le libellé du bouton. */
export function tmpSelection(entries: TmpEntry[], selected: ReadonlySet<string>): { items: TmpDeleteItem[]; entries: TmpEntry[]; sizeKB: number; label: string } {
  const picked = entries.filter((e) => e.refusal === null && selected.has(e.name));
  const sizeKB = picked.reduce((s, e) => s + e.sizeKB, 0);
  return {
    items: picked.map((e) => ({ name: e.name, ino: e.ino, dev: e.dev })),
    entries: picked,
    sizeKB,
    label: picked.length ? `Supprimer la sélection (${picked.length} · ${formatKB(sizeKB)})` : 'Supprimer la sélection',
  };
}

/** Toast après « Vider la quarantaine ». */
export function quarantineMessage(o: TmpDeleteOutcome): { message: string; kind: 'info' | 'error' } {
  if (o.cancelled) return { message: 'Suppression annulée : rien n’a été touché', kind: 'info' };
  const bad = o.results.filter((r) => !r.ok);
  if (!bad.length) return { message: 'Quarantaine vidée', kind: 'info' };
  return { message: `Quarantaine vidée en partie : ${bad.map((r) => `${r.name} (${r.reason ?? 'refusé'})`).join(', ')}`, kind: 'error' };
}

/** Tri de la liste de la page /tmp. */
export type TmpSort = 'size' | 'name';
export const DEFAULT_TMP_SORT: TmpSort = 'size';

const byName = (a: TmpEntry, b: TmpEntry) => displayName(a.name).text.localeCompare(displayName(b.name).text, 'fr', { sensitivity: 'base', numeric: true });

/** Copie triée : par taille décroissante (à taille égale, par nom), ou par nom sans tenir compte de la casse. */
export function sortTmpEntries(entries: readonly TmpEntry[], sort: TmpSort): TmpEntry[] {
  return [...entries].sort(sort === 'name' ? byName : (a, b) => b.sizeKB - a.sizeKB || byName(a, b));
}

export interface TmpTile {
  value: string;
  sub?: string;
  /** Lecture impossible : `sub` porte l'erreur. */
  error?: true;
}

const LOADING = '…';
const DASH = '—';
const failed = (why: string): TmpTile => ({ value: DASH, sub: `Lecture impossible : ${why}`, error: true });
const pct = (n: number) => `${(Math.round(n * 10) / 10).toLocaleString('fr-FR')} %`;

/**
 * Tuiles du haut de la page /tmp : occupé / taille (statfs), part de la RAM, quarantaines restées (et si on peut les vider).
 * En cours de calcul : « … » ; erreur de lecture : « — » et l'erreur.
 */
export function tmpTiles(s: { stats: TmpFsStats | null; statsError: string | null; listing: TmpListing | null; listingError: string | null }): {
  used: TmpTile;
  ram: TmpTile;
  quarantine: TmpTile & { canEmpty: boolean; extra?: string };
} {
  const st = s.stats;
  const used: TmpTile = s.statsError
    ? failed(s.statsError)
    : !st
      ? { value: LOADING }
      : { value: `${formatKB(st.usedKB)} / ${formatKB(st.sizeKB)}`, sub: `${st.sizeKB > 0 ? Math.round((st.usedKB / st.sizeKB) * 100) : 0} % occupé` };
  const ram: TmpTile = s.statsError
    ? failed(s.statsError)
    : !st
      ? { value: LOADING }
      : !st.inRam
        ? { value: DASH, sub: 'pas en RAM : système de fichiers sur disque' }
        : st.memTotalKB > 0
        ? { value: pct((st.usedKB / st.memTotalKB) * 100), sub: `de ${formatKB(st.memTotalKB)} de RAM` }
        : { value: DASH, sub: 'RAM totale inconnue' };
  const l = s.listing;
  // quarantaines = suppressions interrompues ; seules les nôtres (éligibles) sont vidables et comptées
  const n = l ? l.quarantines.filter((q) => q.eligible).length : 0;
  const m = l ? l.quarantines.length - n : 0;
  const quarantine: TmpTile & { canEmpty: boolean; extra?: string } = s.listingError
    ? { ...failed(s.listingError), canEmpty: false }
    : !l
      ? { value: LOADING, canEmpty: false }
      : {
          value: String(n),
          sub: n > 1 ? 'quarantaines restées (suppression interrompue)' : n === 1 ? 'quarantaine restée (suppression interrompue)' : m ? 'aucune quarantaine vidable' : 'aucune suppression interrompue',
          ...(m ? { extra: `+ ${m} non vidable${m > 1 ? 's' : ''}` } : {}),
          canEmpty: n > 0 && !l.disabled,
        };
  return { used, ram, quarantine };
}

/**
 * Garde contre le double clic : tant qu'un appel est en cours, les suivants sont ignorés (résolus à false). Posée avant
 * le premier `await` et indépendante de l'état React (figé dans la closure jusqu'au rendu suivant).
 */
export function createSingleFlight(): (fn: () => Promise<void>) => Promise<boolean> {
  let running = false;
  return async (fn) => {
    if (running) return false;
    running = true;
    try {
      await fn();
      return true;
    } finally {
      running = false;
    }
  };
}
