import type { TmpDeleteItem, TmpDeleteOutcome, TmpEntry } from '../../core/tmpClean';
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
