// Comparaisons « ce qui est affiché » pour React.memo : un snapshot arrive toutes les 3 s avec des objets neufs,
// mais la plupart des cartes et lignes affichent exactement les mêmes textes. Celles-là ne se re-rendent pas.
import type { GroupSummary, ProcInfo } from '../../core/types';
import { categoryDisplayKey } from './categoryFilter';
import { formatAge, formatCpu, formatKB } from './format';
import { barWidth } from './motionBudget';
import { cardTone } from './theme';

const DAY = 86400;

export function sameSeries(a: readonly (number | null)[] | undefined, b: readonly (number | null)[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const sameStrings = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Champs communs aux cartes et aux lignes de la liste. */
function baseEqual(a: GroupSummary, b: GroupSummary): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.protected === b.protected &&
    a.killable === b.killable &&
    a.procCount === b.procCount &&
    formatKB(a.rssKB + a.swapKB) === formatKB(b.rssKB + b.swapKB) &&
    formatCpu(a.cpuPercent) === formatCpu(b.cpuPercent) &&
    formatAge(a.oldestAgeSec) === formatAge(b.oldestAgeSec) &&
    a.oldestAgeSec > DAY === b.oldestAgeSec > DAY &&
    (a.instances === b.instances || categoryDisplayKey(a) === categoryDisplayKey(b))
  );
}

/** Carte : badges et jauge (largeur arrondie, teinte) en plus. */
export function cardDisplayEqual(a: GroupSummary, b: GroupSummary, memTotalA: number, memTotalB: number): boolean {
  if (!baseEqual(a, b) || !sameStrings(a.tags, b.tags) || (a.pssFallback ?? 0) !== (b.pssFallback ?? 0)) return false;
  const pa = ((a.rssKB + a.swapKB) / memTotalA) * 100;
  const pb = ((b.rssKB + b.swapKB) / memTotalB) * 100;
  return barWidth(pa) === barWidth(pb) && cardTone(pa) === cardTone(pb);
}

/** Ligne de la vue liste : colonne swap en plus. */
export function rowDisplayEqual(a: GroupSummary, b: GroupSummary): boolean {
  return baseEqual(a, b) && formatKB(a.swapKB) === formatKB(b.swapKB);
}

/** Ligne de l'arbre des processus. */
export function procRowDisplayEqual(a: ProcInfo, b: ProcInfo): boolean {
  return (
    a.pid === b.pid &&
    a.startTicks === b.startTicks &&
    a.uid === b.uid &&
    a.name === b.name &&
    a.cmdline === b.cmdline &&
    a.cwd === b.cwd &&
    a.cwdDeleted === b.cwdDeleted &&
    !!a.pssDenied === !!b.pssDenied &&
    !!a.pssPending === !!b.pssPending &&
    formatCpu(a.cpuPercent) === formatCpu(b.cpuPercent) &&
    formatKB(a.rssKB) === formatKB(b.rssKB) &&
    formatKB(a.swapKB) === formatKB(b.swapKB) &&
    formatAge(a.ageSec) === formatAge(b.ageSec) &&
    a.ageSec > DAY === b.ageSec > DAY
  );
}
