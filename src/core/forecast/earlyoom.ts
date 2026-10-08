// Seuils d'earlyoom (SIGTERM) pour la prévision ② : lus dans /etc/default/earlyoom, repli 8 % / 35 % si le fichier est
// absent, illisible ou sans EARLYOOM_ARGS.
//
// Lecture : dernière ligne `EARLYOOM_ARGS=` non commentée (comme EnvironmentFile), guillemets retirés, jetons séparés
// par des espaces. Options lues : -m/--mem, -s/--swap (%), -M/-S (Kio) ; formes collées (-m4) et longues (--mem=4),
// décimales (-m 4.5), 1er nombre d'une paire « TERM,KILL ». Les options à valeur consomment le jeton suivant ; une regex
// de --prefer/--avoid/--ignore avec des espaces est lue jusqu'à ses parenthèses équilibrées (un « -m 50 » écrit dans une
// regex n'est jamais pris pour une option). Valeur invalide → défaut du champ (8 % / 35 %, ou rien pour -M/-S).
import { readFileSync } from 'node:fs';

export interface EarlyoomThresholds {
  /** -m : seuil mémoire disponible (% de MemTotal) ; null si seul -M est donné. */
  memPercent: number | null;
  /** -s : seuil swap libre (% de SwapTotal) ; null si seul -S est donné. */
  swapPercent: number | null;
  /** -M / -S : seuils en Kio, null si absents. */
  memKB: number | null;
  swapKB: number | null;
  source: 'file' | 'default';
}

export const DEFAULT_THRESHOLDS: Readonly<EarlyoomThresholds> = Object.freeze({
  memPercent: 8, swapPercent: 35, memKB: null, swapKB: null, source: 'default' as const,
});
export const EARLYOOM_DEFAULTS_FILE = '/etc/default/earlyoom';
/** Défaut d'earlyoom lui-même quand la ligne existe mais ne donne pas l'option. */
const EARLYOOM_OWN_DEFAULT = 10;

/** Options qui prennent une valeur (jeton suivant) sans qu'on la lise. */
const VALUE_OPTIONS = new Set(['-r', '-N', '--prefer', '--avoid', '--ignore', '--sort-by', '-k']);
const REGEX_OPTIONS = new Set(['--prefer', '--avoid', '--ignore']);
type Key = 'm' | 's' | 'M' | 'S';
const LONG: Record<string, Key> = { '--mem': 'm', '--swap': 's' };

const NUM = /^\d+(\.\d+)?$/;
const percent = (v: string | undefined): number | null => {
  const first = v?.split(',')[0] ?? '';
  if (!NUM.test(first)) return null;
  const n = Number(first);
  return n > 0 && n <= 100 ? n : null;
};
const kib = (v: string | undefined): number | null => {
  const first = v?.split(',')[0] ?? '';
  if (!/^\d+$/.test(first)) return null;
  const n = Number(first);
  return n > 0 && Number.isSafeInteger(n) ? n : null;
};

/** Profondeur de parenthèses après ce jeton (pour suivre une regex coupée aux espaces). */
const depthAfter = (tok: string, d: number) => {
  for (const c of tok) {
    if (c === '(') d++;
    else if (c === ')') d = Math.max(0, d - 1);
  }
  return d;
};

const ASSIGN = /^\s*(?:export\s+)?EARLYOOM_ARGS=/;

/** Valeur de la dernière affectation active (`export` accepté), guillemets retirés, commentaire final `# …` hors guillemets ignoré. */
function activeLine(text: string): string | null {
  let line: string | null = null;
  for (const raw of text.split('\n')) {
    const m = ASSIGN.exec(raw);
    if (m) line = raw.slice(m[0].length);
  }
  if (line === null) return null;
  const q = line[0];
  if (q === '"' || q === "'") {
    const end = line.indexOf(q, 1);
    return end > 0 ? line.slice(1, end) : line.slice(1);
  }
  const hash = line.search(/(^|\s)#/);
  return (hash >= 0 ? line.slice(0, hash) : line).trim();
}

export function parseEarlyoomThresholds(text: string | null): EarlyoomThresholds {
  const value = text ? activeLine(text) : null;
  if (value === null) return { ...DEFAULT_THRESHOLDS };
  const tokens = value.split(/\s+/).filter(Boolean);
  const raw: Partial<Record<Key, string | undefined>> = {};
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i]!;
    const eq = tk.indexOf('=');
    const name = tk.startsWith('--') && eq > 0 ? tk.slice(0, eq) : tk;
    const inline = tk.startsWith('--') && eq > 0 ? tk.slice(eq + 1) : undefined;
    if (VALUE_OPTIONS.has(name)) {
      // valeur ignorée ; une regex coupée aux espaces court jusqu'à ses parenthèses équilibrées
      let d = 0;
      if (inline !== undefined) d = depthAfter(inline, 0);
      else if (i + 1 < tokens.length) d = depthAfter(tokens[++i]!, 0);
      if (REGEX_OPTIONS.has(name) && d > 0) {
        // regex coupée aux espaces : jusqu'à ses parenthèses équilibrées si elles le sont plus loin ;
        // sinon (regex mal formée), elle s'arrête à la prochaine option « -… » au lieu d'avaler la fin de la ligne
        let j = i;
        let dj = d;
        while (dj > 0 && j + 1 < tokens.length) dj = depthAfter(tokens[++j]!, dj);
        if (dj === 0) i = j;
        else while (i + 1 < tokens.length && !tokens[i + 1]!.startsWith('-')) i++;
      }
      continue;
    }
    const long = LONG[name];
    if (long) {
      raw[long] = inline ?? tokens[++i] ?? ''; // option sans valeur : invalide
      continue;
    }
    const m = /^-([msMS])(.*)$/.exec(tk);
    if (m) {
      const key = m[1] as Key;
      raw[key] = m[2] !== '' ? m[2] : (tokens[++i] ?? '');
    }
  }
  const memKB = kib(raw.M);
  const swapKB = kib(raw.S);
  const pct = (v: string | undefined, kb: number | null, fallback: number): number | null => {
    if (v === undefined) return kb !== null ? null : EARLYOOM_OWN_DEFAULT;
    return percent(v) ?? fallback;
  };
  return {
    memPercent: pct(raw.m, memKB, DEFAULT_THRESHOLDS.memPercent!),
    swapPercent: pct(raw.s, swapKB, DEFAULT_THRESHOLDS.swapPercent!),
    memKB,
    swapKB,
    source: 'file',
  };
}

/** Lecture du fichier ; toute erreur (absent, droits) → défauts. */
export function readEarlyoomThresholds(path = EARLYOOM_DEFAULTS_FILE, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): EarlyoomThresholds {
  try {
    return parseEarlyoomThresholds(read(path));
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}

export { thresholdKB } from './forecast';
