// Génération, validation et lecture d'EARLYOOM_ARGS (pur : aucun import Node, le renderer l'importe).
//
// Piège d'EnvironmentFile (systemd) : la valeur est coupée aux espaces et les antislashs sont mangés.
// Les regex passées à earlyoom ne contiennent donc jamais d'espace ni d'antislash ; la ligne entière
// n'a d'espaces qu'entre les options.

export interface EarlyoomSettings { memTerm: number; memKill: number; swapTerm: number; swapKill: number; prefer: string[] }

/** Toujours exclus, en tête et dans cet ordre, quelle que soit la liste protégée : terminaux, Claude, session graphique. */
export const EARLYOOM_BASE_IGNORE: readonly string[] =
  ['claude', 'claude-desktop', 'warp', 'zsh', 'bash', 'kwin_wayland', 'kwin_wayland_wr', 'plasmashell', 'Xwayland', 'sddm', 'systemd.*'];

export const EARLYOOM_MAX_PREFER = 30;
const MAX_PART = 100;
/** Longueur maximale de la ligne entière (ASCII seulement : caractères = octets). */
export const EARLYOOM_MAX_LINE = 4095;
/** Longueur du nom de processus (comm) dans le noyau. */
const COMM_MAX_BYTES = 15;

/**
 * Grammaire UNIQUE des motifs de --ignore et --prefer, partagée par le TS et le script root (bash) :
 * une alternance de jetons `[A-Za-z0-9_.-]+`, chacun éventuellement suivi de `.*`. Aucune parenthèse,
 * aucun autre métacaractère : les ancres `^(` … `)$` ne peuvent pas être quittées, et chaque motif compile.
 * Lettres et chiffres sont énumérés (en bash, le sens d'une plage [A-Z] dépend de la locale) ; « - » en dernier.
 */
export const EARLYOOM_TOKEN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-';
const TOKEN = `[${EARLYOOM_TOKEN_CHARS}]+(\\.\\*)?`;
const MORE_TOKENS = `(\\|${TOKEN})*`;
/** Base en littéral (« . », « * », « | » échappés), dans l'ordre fixe. */
const BASE_LITERAL = EARLYOOM_BASE_IGNORE.map((b) => b.replace(/[.*|()^$]/g, (c) => `\\${c}`)).join('\\|');
const MEM = '([123456789]|[1234][0123456789]|50)';
const SWAP = '([123456789]|[123456789][0123456789]|100)';

/**
 * Motif POSIX ERE de la ligne, tel qu'écrit dans le script bash (`re='…'`) ; même syntaxe en JS.
 * Groupes 1 à 4 : SIGTERM et SIGKILL mémoire, puis swap (comparés ensuite : SIGKILL ≤ SIGTERM).
 */
export const EARLYOOM_LINE_PATTERN =
  `^EARLYOOM_ARGS="-m ${MEM},${MEM} -s ${SWAP},${SWAP} -r 0 --ignore \\^\\(${BASE_LITERAL}${MORE_TOKENS}\\)\\$( --prefer \\^\\(${TOKEN}${MORE_TOKENS}\\)\\$)?"$`;

export const EARLYOOM_LINE_RE = new RegExp(EARLYOOM_LINE_PATTERN);
const TOKEN_RE = new RegExp(`^${TOKEN}$`);

/** Politique appliquée aussi par le script root : longueur, forme et bornes (motif), puis SIGKILL ≤ SIGTERM. null si acceptée. */
export function checkEarlyoomLine(line: string): string | null {
  if (line.length > EARLYOOM_MAX_LINE) return `Ligne trop longue (${line.length} caractères, ${EARLYOOM_MAX_LINE} au plus)`;
  const m = EARLYOOM_LINE_RE.exec(line);
  if (!m) return 'Ligne non conforme (forme, bornes, exclusions de base ou motifs)';
  if (Number(m[2]) > Number(m[1]) || Number(m[4]) > Number(m[3])) return 'Seuil SIGKILL supérieur au seuil SIGTERM';
  return null;
}

const NAME_SAFE = /^[A-Za-z0-9_-]$/;
/**
 * Nom exact → motif : tronqué à 15 octets comme le comm du noyau (« gnome-terminal-server » → « gnome-terminal- »),
 * puis tout caractère hors [A-Za-z0-9_-] devient « . » (« node (vitest) » → « node..vitest. »).
 */
export function nameToRegex(name: string): string {
  let bytes = 0;
  let out = '';
  for (const c of name) {
    const n = new TextEncoder().encode(c).length;
    if (bytes + n > COMM_MAX_BYTES) break;
    bytes += n;
    out += NAME_SAFE.test(c) ? c : '.';
  }
  return out;
}

/** Noms protégés dont le motif diffère du nom (tronqués ou caractères remplacés par « . »), pour l'aperçu. */
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

/** Message d'erreur en français, ou null si le motif est accepté : non vide, ≤ 100 caractères, jeton `[A-Za-z0-9_.-]+` éventuellement suivi de `.*`. */
export function checkRegexPart(part: string): string | null {
  if (part === '') return 'Motif vide';
  if (/\s/.test(part)) return `« ${part} » : espace interdite (EnvironmentFile coupe la ligne aux espaces)`;
  if (part.includes('\\')) return `« ${part} » : antislash interdit (EnvironmentFile le supprime) — utiliser « . »`;
  if (part.length > MAX_PART) return `« ${part.slice(0, 20)}… » : plus de ${MAX_PART} caractères`;
  const bad = Array.from(part).find((c) => !EARLYOOM_TOKEN_CHARS.includes(c) && c !== '*');
  if (bad !== undefined) return `« ${part} » : caractère interdit « ${bad} » (un motif par ligne, lettres, chiffres, _ . -)`;
  if (!TOKEN_RE.test(part)) return `« ${part} » : « * » n'est permis qu'à la fin, sous la forme « .* » après au moins un caractère`;
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
  const bad = checkEarlyoomLine(line);
  if (bad) return { ok: false, errors: [bad.startsWith('Ligne trop longue') ? `${bad} : raccourcir la liste protégée ou les préférences` : bad] };
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
