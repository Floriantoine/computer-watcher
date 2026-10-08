// Dialogue de confirmation groupée (« Tuer la sélection », « Tuer le front / le back », « Tout arrêter ») : fonctions pures.
import type { InstanceSummary, KillResult, KillTarget } from '../../core/types';

/** Cibles au plus par appel du handler `kill`. */
export const MAX_KILL_TARGETS = 2000;
/** Clés au plus par appel de `instances:targets` et `classify:inactive` (borne du main). */
export const MAX_KEYS_PER_CALL = 200;

export type Preset = 'all' | 'inactive1h' | 'inactive1d' | 'duplicates';
export const PRESETS: { id: Preset; label: string }[] = [
  { id: 'all', label: 'Toutes' },
  { id: 'inactive1h', label: 'Inactives > 1 h' },
  { id: 'inactive1d', label: 'Inactives > 1 j' },
  { id: 'duplicates', label: 'Doublons seulement' },
];
export const INACTIVE_SINCE_MS: Record<'inactive1h' | 'inactive1d', number> = { inactive1h: 3600_000, inactive1d: 86400_000 };

/** Résultat de `classify:inactive` par période : undefined = en cours, null = pas d'historique. */
export interface InactiveState {
  h1?: ReadonlySet<string> | null;
  d1?: ReadonlySet<string> | null;
}

const inactiveOf = (preset: 'inactive1h' | 'inactive1d', s: InactiveState) => (preset === 'inactive1h' ? s.h1 : s.d1);

/** Cochées à l'ouverture : toutes sauf les protégées et celles dont tous les processus ont déjà reçu SIGTERM. */
export function defaultSelection(list: readonly InstanceSummary[], pendingPids?: { has(pid: number): boolean }): Set<string> {
  const allPending = (i: InstanceSummary) => !!pendingPids && i.pids.length > 0 && i.pids.every((p) => pendingPids.has(p));
  return new Set(list.filter((i) => !i.protected && !allPending(i)).map((i) => i.key));
}

export function toggleKey(sel: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(sel);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** Raccourci de pré-sélection ; les protégées ne sont jamais cochées par un raccourci. null si indisponible. */
export function presetSelection(list: readonly InstanceSummary[], preset: Preset, inactive: InactiveState): Set<string> | null {
  const open = list.filter((i) => !i.protected);
  if (preset === 'all') return new Set(open.map((i) => i.key));
  if (preset === 'duplicates') return new Set(open.filter((i) => i.duplicate).map((i) => i.key));
  const set = inactiveOf(preset, inactive);
  if (!set) return null;
  return new Set(open.filter((i) => set.has(i.key)).map((i) => i.key));
}

export function presetState(preset: Preset, inactive: InactiveState): { enabled: boolean; reason?: string } {
  if (preset === 'all' || preset === 'duplicates') return { enabled: true };
  const set = inactiveOf(preset, inactive);
  if (set === undefined) return { enabled: false, reason: "Lecture de l'historique…" };
  if (set === null) return { enabled: false, reason: "Pas d'historique : le service d'enregistrement est arrêté ou n'a encore rien enregistré" };
  return { enabled: true };
}

/** Clés cochées encore présentes au dernier snapshot, dans l'ordre de la liste. */
export function checkedLive(list: readonly InstanceSummary[], sel: ReadonlySet<string>, live: ReadonlySet<string>): string[] {
  return list.filter((i) => sel.has(i.key) && live.has(i.key)).map((i) => i.key);
}

/**
 * Lanceurs (npm, sh…) du groupe : seulement pour « Tout arrêter », et seulement si toutes ses instances encore présentes
 * sont cochées (tuer un lanceur peut emporter une instance laissée décochée).
 */
export function includeLaunchers(
  launchersOf: string | undefined,
  list: readonly InstanceSummary[],
  sel: ReadonlySet<string>,
  live: ReadonlySet<string>,
): boolean {
  if (!launchersOf) return false;
  const present = list.filter((i) => live.has(i.key));
  return present.length > 0 && present.every((i) => sel.has(i.key));
}

function chunks<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export type TargetsFn = (keys: string[]) => Promise<{ key: string; targets: KillTarget[] }[]>;
export type InactiveFn = (keys: string[], sinceMs: number) => Promise<string[] | null>;

/** `instances:targets` par lots de 200 clés. */
export async function fetchTargets(keys: readonly string[], fn: TargetsFn): Promise<{ key: string; targets: KillTarget[] }[]> {
  const out: { key: string; targets: KillTarget[] }[] = [];
  for (const batch of chunks(keys, MAX_KEYS_PER_CALL)) out.push(...(await fn(batch)));
  return out;
}

/** `classify:inactive` par lots de 200 clés ; null dès qu'un lot n'a pas d'historique. */
export async function fetchInactive(keys: readonly string[], sinceMs: number, fn: InactiveFn): Promise<Set<string> | null> {
  const out = new Set<string>();
  for (const batch of chunks(keys, MAX_KEYS_PER_CALL)) {
    const r = await fn(batch, sinceMs);
    if (r === null) return null;
    for (const k of r) out.add(k);
  }
  return out;
}

export interface InstanceTargets {
  key: string;
  targets: KillTarget[];
}

/** Réponse de `instances:targets` → instances à tuer, lanceurs (clé = id du groupe), clés disparues (absentes ou sans processus). */
export function splitEntries(
  checked: readonly string[],
  launchersOf: string | undefined,
  entries: readonly InstanceTargets[],
): { instances: InstanceTargets[]; launchers: KillTarget[]; gone: string[] } {
  const byKey = new Map(entries.map((e) => [e.key, e.targets]));
  const instances: InstanceTargets[] = [];
  const gone: string[] = [];
  for (const key of checked) {
    const targets = byKey.get(key);
    if (targets?.length) instances.push({ key, targets });
    else gone.push(key);
  }
  const launchers = launchersOf ? (byKey.get(launchersOf) ?? []) : [];
  return { instances, launchers, gone };
}

/**
 * Lots d'au plus 2 000 cibles pour le handler `kill` (qui ordonne enfants d'abord dans chaque appel) : une instance reste
 * dans un même lot quand elle y tient ; les lanceurs passent en dernier. Un pid n'est envoyé qu'une fois.
 */
export function killBatches(instances: readonly InstanceTargets[], launchers: readonly KillTarget[]): KillTarget[][] {
  const seen = new Set<number>();
  const units = [...instances.map((i) => i.targets), launchers].map((ts) =>
    ts.filter((t) => {
      if (seen.has(t.pid)) return false;
      seen.add(t.pid);
      return true;
    }),
  );
  const out: KillTarget[][] = [];
  let cur: KillTarget[] = [];
  for (const u of units) {
    if (!u.length) continue;
    if (cur.length + u.length > MAX_KILL_TARGETS && cur.length) {
      out.push(cur);
      cur = [];
    }
    for (const part of chunks(u, MAX_KILL_TARGETS)) {
      if (cur.length + part.length > MAX_KILL_TARGETS) {
        out.push(cur);
        cur = [];
      }
      cur.push(...part);
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

function reason(r: KillResult): string {
  if (r.error === 'EPERM') return 'permission refusée';
  if (r.error === 'SELF') return "c'est proc-watch ou l'un de ses parents";
  return r.error ?? 'erreur inconnue';
}

/**
 * Toast récapitulatif d'un kill groupé. `perInstance` : pids envoyés par instance ; `results` : réponses du handler `kill`
 * (lanceurs compris) ; `goneBefore` : instances déjà absentes avant l'envoi. Une instance est arrêtée si au moins un de ses
 * processus a reçu le signal et qu'aucun n'a été refusé ; disparue si tous étaient déjà partis (ESRCH).
 */
export function summarizeResults(
  perInstance: readonly { key: string; pids: readonly number[] }[],
  results: readonly KillResult[],
  goneBefore: number,
): { message: string; kind: 'info' | 'error' } {
  const byPid = new Map(results.map((r) => [r.pid, r]));
  let killed = 0;
  let refused = 0;
  let gone = goneBefore;
  for (const inst of perInstance) {
    const rs = inst.pids.map((p) => byPid.get(p)).filter((r): r is KillResult => !!r);
    if (rs.some((r) => !r.ok && r.error !== 'ESRCH')) refused++;
    else if (rs.some((r) => r.ok)) killed++;
    else gone++;
  }
  const errors = results.filter((r) => !r.ok && r.error !== 'ESRCH');
  const parts = [killed ? plural(killed, 'instance arrêtée', 'instances arrêtées') : 'Aucune instance arrêtée'];
  if (refused) parts.push(plural(refused, 'refusée', 'refusées'));
  if (gone) parts.push(plural(gone, 'déjà disparue', 'déjà disparues'));
  let message = parts.join(', ');
  if (errors.length) {
    const shown = errors.slice(0, 3).map((r) => `PID ${r.pid} ${reason(r)}`);
    if (errors.length > 3) shown.push(`+${errors.length - 3}`);
    message += ` : ${shown.join(', ')}`;
  }
  return { message, kind: errors.length ? 'error' : 'info' };
}

/** Titre du dialogue ; `singleName` = nom du projet quand la liste vient d'un seul groupe (boutons du détail). */
export function bulkDialogTitle(list: readonly InstanceSummary[], launchersOf: string | undefined, singleName: string | null): string {
  if (launchersOf && singleName) return `Tout arrêter dans « ${singleName} » ?`;
  const what = plural(list.length, 'instance', 'instances');
  if (singleName) return `Arrêter ${what} de « ${singleName} » ?`;
  const projects = new Set(list.map((i) => i.project ?? i.groupId)).size;
  return `Arrêter ${what} de ${plural(projects, 'projet', 'projets')} ?`;
}
