import { inBounds, RECORDER_BOUNDS, type RecorderNumField } from '../../core/recorderBounds';
import type { RecorderConfig } from '../../core/types';

export const RECORDER_FIELDS: RecorderNumField[] = ['intervalSec', 'detailHours', 'summaryDays', 'procMinMemMB', 'procMinCpuPercent', 'groupMinMemMB', 'leakMinMinutes', 'leakMinGrowthMB'];

export type RecorderForm = Record<RecorderNumField, string>;
export type RecorderErrors = Partial<Record<RecorderNumField, string>>;

export function recorderToForm(r: RecorderConfig): RecorderForm {
  return Object.fromEntries(RECORDER_FIELDS.map((f) => [f, String(r[f])])) as RecorderForm;
}

function boundsMessage(f: RecorderNumField): string {
  const b = RECORDER_BOUNDS[f];
  const kind = b.int ? 'entier' : 'nombre';
  return b.max === undefined ? `Un ${kind} ≥ ${b.min} est attendu` : `Un ${kind} entre ${b.min} et ${b.max} est attendu`;
}

/** Validation locale du formulaire, mêmes bornes que `validateConfig` ; `value` n'est présent que si tout est valide. */
export function validateRecorderForm(form: RecorderForm, enabled: boolean): { value?: RecorderConfig; errors: RecorderErrors } {
  const errors: RecorderErrors = {};
  const out: Record<string, number> = {};
  for (const f of RECORDER_FIELDS) {
    const raw = form[f].trim();
    const n = raw === '' ? NaN : Number(raw);
    if (inBounds(n, RECORDER_BOUNDS[f])) out[f] = n;
    else errors[f] = raw === '' ? 'Valeur requise' : boundsMessage(f);
  }
  if (Object.keys(errors).length) return { errors };
  return { value: { enabled, ...out } as unknown as RecorderConfig, errors };
}

/** Clé stable des groupes en fuite : l'événement le plus récent par groupe (ts), pour ne pas re-rendre les cartes à chaque rafraîchissement. */
export function leakTimes(events: { ts: number; type: string; groupKey: string | null }[] | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of events ?? []) if (e.type === 'leak' && e.groupKey && e.ts > (m.get(e.groupKey) ?? -1)) m.set(e.groupKey, e.ts);
  return m;
}
