// Frigo (anti-gel lot 3), fenêtre (logique pure) : textes du badge, ligne du détail, ligne de la carte Métriques, notices.
import type { FridgeEntryState, FridgePhase } from '../../core/antigel/fridgeState';
import type { AntigelView } from '../../core/antigel/state';
import { formatKB } from './format';

const live = (v: AntigelView | null) => (v && v.fresh && v.state && v.state.status === 'active' ? v.state : null);

/**
 * Entrée du frigo d'une racine de projet. Même si l'état n'est plus frais (service en difficulté) : « Réveiller » reste
 * proposé, c'est le sens sûr (le main l'accepte toujours).
 */
export function fridgeEntry(v: AntigelView | null, root: string | null): FridgeEntryState | null {
  const s = v?.state ?? null;
  if (!s || root === null) return null;
  return s.fridge?.find((e) => e.root === root) ?? null;
}

export function fridgeBadgeText(p: FridgePhase): string {
  return p === 'freezing' ? 'mise au frigo…' : p === 'thawing' ? 'réveil…' : 'au frigo';
}

export function fridgeBadgeTitle(p: FridgePhase): string {
  if (p === 'thawing') return 'Réveil en cours';
  if (p === 'freezing') return 'Mise au frigo en cours : processus en cours de gel';
  if (p === 'reclaiming') return 'Au frigo : processus gelés, mémoire en cours de passage en swap';
  return 'Au frigo : processus gelés, mémoire passée en swap autant que possible';
}

const hhmm = (ts: number) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Ligne du détail d'un projet au frigo. */
export function fridgeDetailLine(e: FridgeEntryState): string {
  const freed = e.reclaimedKB >= 1024 ? ` · ≈ ${formatKB(e.reclaimedKB)} sortis de la RAM` : '';
  const head = e.phase === 'reclaiming' ? `Au frigo depuis ${hhmm(e.since)}, mémoire en cours de passage en swap` : e.phase === 'thawing' ? 'Réveil en cours' : `Au frigo depuis ${hhmm(e.since)}`;
  return `${head}${freed}. Ses processus sont suspendus : « Tuer » n’agit qu’au réveil (« Forcer » arrête tout de suite) ; ce que vous relancez dans ce projet tourne normalement, hors plafond, jusqu’au réveil.`;
}

/** Carte Métriques : « 2 projets au frigo · ≈ 3,4 Go sortis de la RAM » ; null si aucun. */
export function fridgeCardLine(v: AntigelView | null): string | null {
  const s = live(v);
  const list = s?.fridge ?? [];
  if (!list.length) return null;
  const kb = list.reduce((a, e) => a + e.reclaimedKB, 0);
  return `${list.length} projet${list.length > 1 ? 's' : ''} au frigo${kb >= 1024 ? ` · ≈ ${formatKB(kb)} sortis de la RAM` : ''}`;
}

/** Nouvelle notice du service depuis `seenAt` (null : première lecture, rien n'est montré). */
export function newFridgeNotice(v: AntigelView | null, seenAt: number | null): { text: string; ok: boolean; at: number } | null {
  const n = v?.state?.fridgeNotice;
  if (!n || seenAt === null || n.at <= seenAt) return null;
  return { text: n.text, ok: n.ok, at: n.at };
}
