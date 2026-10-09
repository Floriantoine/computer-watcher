import { buildEarlyoomArgs, checkRegexPart, EARLYOOM_MAX_PREFER, type EarlyoomSettings } from '../../core/earlyoom';
import { EARLYOOM_DEFAULT_SETTINGS, EARLYOOM_TEST_PREFER } from '../../core/earlyoomSetup';
import type { EarlyoomStatus, HistoryEvent } from '../../core/types';

/** Champs du formulaire (texte brut) ; `prefer` : un motif par ligne. */
export interface EarlyoomForm { memTerm: string; memKill: string; swapTerm: string; swapKill: string; prefer: string }
export type EarlyoomFormErrors = Partial<Record<keyof EarlyoomForm, string>>;

const D = EARLYOOM_DEFAULT_SETTINGS;
const DEFAULT_FORM: EarlyoomForm = { memTerm: String(D.memTerm), memKill: String(D.memKill), swapTerm: String(D.swapTerm), swapKill: String(D.swapKill), prefer: D.prefer.join('\n') };

/** Fichier lu, sinon 8,5 / 35,25 / processus de test préférés. */
export function formFromStatus(st: EarlyoomStatus): EarlyoomForm {
  const s = st.file?.settings;
  if (!s) return { ...DEFAULT_FORM };
  return { memTerm: String(s.memTerm), memKill: String(s.memKill), swapTerm: String(s.swapTerm), swapKill: String(s.swapKill), prefer: s.prefer.join('\n') };
}

const preferLines = (text: string): string[] => text.split('\n').map((l) => l.trim()).filter(Boolean);

/** Processus de test absents de la liste. */
export const missingTestPrefer = (text: string): string[] => {
  const lines = preferLines(text);
  return EARLYOOM_TEST_PREFER.filter((p) => !lines.includes(p));
};

/** Ajoute à la liste les processus de test qui y manquent, sans rien retirer ni réordonner. */
export function withTestPrefer(text: string): string {
  const lines = preferLines(text);
  const missing = missingTestPrefer(text);
  return missing.length ? [...lines, ...missing].join('\n') : lines.join('\n');
}

function intField(raw: string, min: number, max: number): { n?: number; error?: string } {
  const t = raw.trim();
  if (t === '') return { error: 'Valeur requise' };
  const n = Number(t);
  if (!Number.isInteger(n) || n < min || n > max) return { error: `Un entier entre ${min} et ${max} est attendu` };
  return { n };
}

/** Validation locale ; `settings` et `preview` (ligne exacte) ne sont présents que si tout est valide. */
export function validateEarlyoomForm(
  f: EarlyoomForm,
  protectedList: readonly string[],
): { settings?: EarlyoomSettings; preview?: string; errors: EarlyoomFormErrors } {
  const errors: EarlyoomFormErrors = {};
  const memTerm = intField(f.memTerm, 1, 50);
  const swapTerm = intField(f.swapTerm, 1, 100);
  const memKill = intField(f.memKill, 1, memTerm.n ?? 50);
  const swapKill = intField(f.swapKill, 1, swapTerm.n ?? 100);
  for (const [k, r] of [['memTerm', memTerm], ['memKill', memKill], ['swapTerm', swapTerm], ['swapKill', swapKill]] as const) {
    if (r.error) errors[k] = r.error;
  }
  const prefer = preferLines(f.prefer);
  const pe = prefer.map(checkRegexPart).filter((e): e is string => e !== null);
  if (prefer.length > EARLYOOM_MAX_PREFER) pe.unshift(`${EARLYOOM_MAX_PREFER} motifs au plus (${prefer.length})`);
  if (pe.length) errors.prefer = pe.join(' · ');
  if (Object.keys(errors).length) return { errors };
  const settings: EarlyoomSettings = { memTerm: memTerm.n!, memKill: memKill.n!, swapTerm: swapTerm.n!, swapKill: swapKill.n!, prefer };
  const built = buildEarlyoomArgs(settings, protectedList);
  if (!built.ok) return { errors: { prefer: built.errors.join(' · ') } };
  return { settings, preview: built.line, errors };
}

/** Derniers kills earlyoom (n = 3), plus récents d'abord. */
export function lastEarlyoomKills(events: readonly HistoryEvent[], n = 3): { ts: number; name: string; signal: string }[] {
  return events
    .filter((e) => e.type === 'earlyoom_kill')
    .sort((a, b) => b.ts - a.ts)
    .slice(0, n)
    .map((e) => ({ ts: e.ts, name: String(e.detail?.name ?? '?'), signal: e.detail?.signal ? String(e.detail.signal) : '' }));
}
