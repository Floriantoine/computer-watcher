// Carte « Autres » dépliable : état mémorisé (localStorage) et aperçu de ses plus gros sous-groupes.
import type { GroupSummary } from '../../core/types';
import { formatCpu, formatKB } from './format';

export const OTHERS_OPEN_KEY = 'pw.othersOpen';
const PREVIEW = 10;

const defaultStorage = (): Storage | undefined => (typeof localStorage === 'undefined' ? undefined : localStorage);

/** État déplié mémorisé ; stockage absent ou qui lève → replié. */
export function readOthersOpen(storage: Pick<Storage, 'getItem'> | undefined = defaultStorage()): boolean {
  try {
    return storage?.getItem(OTHERS_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** Mémorise l'état déplié ; stockage indisponible → l'état vaut pour la session seulement. */
export function writeOthersOpen(open: boolean, storage: Pick<Storage, 'setItem'> | undefined = defaultStorage()): void {
  try {
    storage?.setItem(OTHERS_OPEN_KEY, open ? '1' : '0');
  } catch {
    /* stockage indisponible */
  }
}

const memOf = (g: GroupSummary) => g.rssKB + g.swapKB;

/** Les `n` plus gros sous-groupes (RAM + swap décroissant) et le nombre de ceux qui ne sont pas montrés. */
export function othersPreview(g: GroupSummary, n = PREVIEW): { shown: GroupSummary[]; hidden: number } {
  const shown = [...g.subgroups].sort((a, b) => memOf(b) - memOf(a) || a.label.localeCompare(b.label)).slice(0, n);
  return { shown, hidden: Math.max(0, g.subgroups.length - shown.length) };
}

/** Aperçu affiché identique : mêmes sous-groupes dans le même ordre, mêmes Mo et CPU affichés, même nombre de cachés. */
export function othersPreviewEqual(a: GroupSummary, b: GroupSummary, n = PREVIEW): boolean {
  if (a.subgroups === b.subgroups) return true;
  const pa = othersPreview(a, n);
  const pb = othersPreview(b, n);
  if (pa.hidden !== pb.hidden || pa.shown.length !== pb.shown.length) return false;
  return pa.shown.every((x, i) => {
    const y = pb.shown[i]!;
    return x.id === y.id && x.label === y.label && formatKB(memOf(x)) === formatKB(memOf(y)) && formatCpu(x.cpuPercent) === formatCpu(y.cpuPercent);
  });
}
