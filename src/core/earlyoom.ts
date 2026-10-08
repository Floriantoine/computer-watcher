// Génération, validation et lecture d'EARLYOOM_ARGS (pur : aucun import Node, le renderer l'importe).
//
// Piège d'EnvironmentFile (systemd) : la valeur est coupée aux espaces et les antislashs sont mangés.
// Les regex passées à earlyoom ne contiennent donc jamais d'espace ni d'antislash ; la ligne entière
// n'a d'espaces qu'entre les options.

export interface EarlyoomSettings { memTerm: number; memKill: number; swapTerm: number; swapKill: number; prefer: string[] }

/** Toujours exclus, quelle que soit la liste protégée : terminaux, Claude et la session graphique. */
export const EARLYOOM_BASE_IGNORE: readonly string[] =
  ['claude', 'claude-desktop', 'warp', 'zsh', 'bash', 'kwin_wayland', 'plasmashell', 'Xwayland', 'sddm', 'systemd.*'];

export const EARLYOOM_MAX_PREFER = 30;
const MAX_PART = 100;

/**
 * Liste blanche UNIQUE des caractères permis dans les regex de --ignore et --prefer (noms de processus en
 * alternance). Lettres et chiffres énumérés (pas de plage [A-Z], dont le sens dépend de la locale en bash).
 * Exclus en particulier : $ ` ; ' " \ espace # { } [ ] < > & et tout caractère non ASCII.
 * Elle sert à construire à la fois EARLYOOM_LINE_RE (TS) et le motif `re=` du script root (bash).
 */
export const EARLYOOM_REGEX_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._|*+?()-';
const CLASS = `[${EARLYOOM_REGEX_CHARS}]+`;
const DIGITS = '[0123456789]';

/** Motif POSIX ERE de la ligne, tel qu'écrit dans le script bash (`re='…'`) ; identique en syntaxe JS. */
export const EARLYOOM_LINE_PATTERN =
  `^EARLYOOM_ARGS="-m ${DIGITS}{1,2},${DIGITS}{1,2} -s ${DIGITS}{1,3},${DIGITS}{1,3} -r 0 --ignore \\^\\(${CLASS}\\)\\$( --prefer \\^\\(${CLASS}\\)\\$)?"$`;

/** Ligne acceptée par le script root : construite depuis le même motif que le script bash de src/main/earlyoom.ts. */
export const EARLYOOM_LINE_RE = new RegExp(EARLYOOM_LINE_PATTERN);

/** Taille maximale du fichier lu par le script root (ligne + saut de ligne). */
export const EARLYOOM_MAX_FILE_BYTES = 4096;

const NAME_SAFE = /^[A-Za-z0-9_-]$/;
/** Nom exact → motif sans espace ni antislash : tout caractère hors [A-Za-z0-9_-] devient « . » (« node (vitest) » → « node..vitest. »). */
export function nameToRegex(name: string): string {
  return Array.from(name, (c) => (NAME_SAFE.test(c) ? c : '.')).join('');
}

/** Noms protégés dont le motif diffère du nom (caractères hors liste blanche remplacés par « . »), pour l'aperçu. */
export function ignoreConversions(protectedList: readonly string[]): { name: string; re: string }[] {
  return protectedList.filter((n) => !/^\/.+\/$/.test(n) && n !== '').map((name) => ({ name, re: nameToRegex(name) })).filter((c) => c.re !== c.name);
}

/** Base puis noms exacts de la liste protégée (entrées /regex/ ignorées), sans doublon. */
export function ignoreList(protectedList: readonly string[]): string[] {
  const out = [...EARLYOOM_BASE_IGNORE];
  const seen = new Set(out);
  for (const entry of protectedList) {
    if (/^\/.+\/$/.test(entry)) continue;
    const re = nameToRegex(entry);
    if (!re || seen.has(re)) continue;
    seen.add(re);
    out.push(re);
  }
  return out;
}

/** Message d'erreur en français, ou null si le motif est accepté : non vide, ≤ 100 caractères, uniquement EARLYOOM_REGEX_CHARS. */
export function checkRegexPart(part: string): string | null {
  if (part === '') return 'Motif vide';
  if (/\s/.test(part)) return `« ${part} » : espace interdite (EnvironmentFile coupe la ligne aux espaces)`;
  if (part.includes('\\')) return `« ${part} » : antislash interdit (EnvironmentFile le supprime) — utiliser « . »`;
  if (part.length > MAX_PART) return `« ${part.slice(0, 20)}… » : plus de ${MAX_PART} caractères`;
  const bad = Array.from(part).find((c) => !EARLYOOM_REGEX_CHARS.includes(c));
  if (bad !== undefined) return `« ${part} » : caractère interdit « ${bad} »`;
  return null;
}

function checkInt(label: string, v: number, min: number, max: number, errors: string[]): void {
  if (!Number.isInteger(v) || v < min || v > max) errors.push(`${label} : entier entre ${min} et ${max} attendu`);
}

/** Bornes : memTerm 1–50, memKill 1–memTerm, swapTerm 1–100, swapKill 1–swapTerm, entiers ; prefer ≤ 30 motifs. */
export function buildEarlyoomArgs(
  s: EarlyoomSettings,
  protectedList: readonly string[],
): { ok: true; line: string } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  checkInt('Mémoire (SIGTERM)', s.memTerm, 1, 50, errors);
  checkInt('Mémoire (SIGKILL)', s.memKill, 1, Number.isInteger(s.memTerm) ? Math.max(1, Math.min(50, s.memTerm)) : 50, errors);
  checkInt('Swap (SIGTERM)', s.swapTerm, 1, 100, errors);
  checkInt('Swap (SIGKILL)', s.swapKill, 1, Number.isInteger(s.swapTerm) ? Math.max(1, Math.min(100, s.swapTerm)) : 100, errors);
  if (s.prefer.length > EARLYOOM_MAX_PREFER) errors.push(`Préférences : ${EARLYOOM_MAX_PREFER} motifs au plus`);
  for (const p of s.prefer) {
    const e = checkRegexPart(p);
    if (e) errors.push(`Préférence ${e}`);
  }
  const ignore = ignoreList(protectedList);
  for (const p of ignore) {
    const e = checkRegexPart(p);
    if (e) errors.push(`Exclusion ${e}`);
  }
  if (errors.length) return { ok: false, errors };
  const prefer = s.prefer.length ? ` --prefer ^(${s.prefer.join('|')})$` : '';
  const line = `EARLYOOM_ARGS="-m ${s.memTerm},${s.memKill} -s ${s.swapTerm},${s.swapKill} -r 0 --ignore ^(${ignore.join('|')})$${prefer}"`;
  if (line.length + 1 > EARLYOOM_MAX_FILE_BYTES) return { ok: false, errors: [`Ligne trop longue (${line.length} caractères, ${EARLYOOM_MAX_FILE_BYTES - 1} au plus) : raccourcir la liste protégée ou les préférences`] };
  if (!EARLYOOM_LINE_RE.test(line)) return { ok: false, errors: ['Ligne générée non conforme'] };
  return { ok: true, line };
}

/** Coupe aux « | » de premier niveau (hors parenthèses, hors caractère échappé). */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { cur += c + (s[i + 1] ?? ''); i++; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === '|' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.filter((p) => p !== '');
}

function parsePair(v: string | undefined, fallback: [number, number]): [number, number] {
  if (!v) return fallback;
  const [a, b] = v.split(',');
  const term = Math.floor(Number(a));
  if (!Number.isFinite(term)) return fallback;
  const kill = b === undefined || b === '' ? Math.floor(term / 2) : Math.floor(Number(b));
  return [term, Number.isFinite(kill) ? kill : Math.floor(term / 2)];
}

/** Lecture de /etc/default/earlyoom : seuils (KILL absent = PERCENT/2 arrondi à l'entier inférieur, comme earlyoom), préférences ; antislashs convertis. null si aucune ligne EARLYOOM_ARGS. */
export function parseEarlyoomDefault(text: string): { settings: EarlyoomSettings; converted: string[]; line: string } | null {
  let line: string | null = null;
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (/^EARLYOOM_ARGS=/.test(t)) line = t; // la dernière affectation l'emporte, comme EnvironmentFile
  }
  if (line === null) return null;
  let value = line.slice('EARLYOOM_ARGS='.length);
  const q = value[0];
  if ((q === '"' || q === "'") && value.endsWith(q) && value.length >= 2) value = value.slice(1, -1);
  const tokens = value.split(/\s+/).filter(Boolean);
  const opt = (short: string, long: string): string | undefined => {
    let found: string | undefined;
    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];
      if (tk === short || tk === long) found = tokens[i + 1];
      else if (tk.startsWith(short) && short.length === 2 && !tk.startsWith('--')) found = tk.slice(2);
      else if (tk.startsWith(`${long}=`)) found = tk.slice(long.length + 1);
    }
    return found;
  };
  const [memTerm, memKill] = parsePair(opt('-m', '--mem'), [10, 5]);
  const [swapTerm, swapKill] = parsePair(opt('-s', '--swap'), [10, 5]);
  const converted: string[] = [];
  const prefer: string[] = [];
  const pv = opt('--prefer', '--prefer');
  if (pv) {
    const m = pv.match(/^\^\((.*)\)\$$/);
    for (const part of m ? splitTopLevel(m[1]) : [pv]) {
      if (part.includes('\\')) {
        converted.push(part);
        prefer.push(part.replace(/\\[\s\S]?/g, '.'));
      } else prefer.push(part);
    }
  }
  return { settings: { memTerm, memKill, swapTerm, swapKill, prefer }, converted, line };
}

export function isEarlyoomSettings(v: unknown): v is EarlyoomSettings {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  const num = (x: unknown): boolean => typeof x === 'number' && Number.isFinite(x);
  return num(o.memTerm) && num(o.memKill) && num(o.swapTerm) && num(o.swapKill)
    && Array.isArray(o.prefer) && o.prefer.length <= 1000 && o.prefer.every((p) => typeof p === 'string');
}
