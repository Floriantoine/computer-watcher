// Anti-gel : lancer directement dans le budget. Décide, sans rien exécuter, si une ligne de commande tapée (zsh) ou
// envoyée par Claude Code (hook PreToolUse) doit passer par `computer-watcher run -- …`, et la réécrit.
//
// Pourquoi : en cgroups v2, la mémoire allouée avant qu'un processus soit déplacé dans un budget reste comptée là où elle
// a été allouée. Un jest capturé quelques secondes après son lancement a déjà dépassé son budget : il faut naître dedans.
//
// Prudence avant tout : au moindre doute (ligne incomplète, heredoc, changement d'état du shell, commande interactive,
// déjà enveloppée), aucune réécriture. Pur : le dossier courant, la config et la racine du projet sont fournis.
import { budgetKey, type AntigelConfig } from './config';
import { workRoot } from './run';

export interface WrapCtx {
  home: string;
  env: NodeJS.ProcessEnv;
  /** Section `antigel` de config.json ; null : config absente, illisible ou refusée. */
  config: AntigelConfig | null;
  /** Racine du projet d'un dossier (findProjectRoot), null hors projet. */
  findRoot: (cwd: string) => string | null;
}

export type WrapShell = 'sh' | 'bash' | 'zsh';
export interface WrapOptions {
  /** Shell des lignes composées (`<shell> -c '<ligne>'`) ; défaut sh. */
  shell?: WrapShell;
  /** Lanceur ; défaut `computer-watcher` (cherché dans le PATH par le shell). */
  bin?: string;
}

// ——— Commandes lourdes (liste extensible) ———

/** Toujours lourdes, quels que soient leurs arguments. */
const HEAVY_ANY = new Set([
  'jest', 'vitest', 'mocha', 'ava', 'karma', 'tsc', 'vue-tsc', 'eslint', 'playwright', 'cypress', 'webpack', 'rollup', 'vite', 'next', 'nuxt',
  'turbo', 'nx', 'lerna', 'npx', 'pnpx', 'bunx', 'make', 'gmake', 'ninja', 'gradle', 'gradlew', 'mvn', 'mvnw', 'sbt', 'bazel', 'bazelisk',
  'pytest', 'tox', 'nox', 'ctest', 'rspec', 'phpunit',
]);
/** Lourdes avec l'une de ces sous-commandes (premier argument qui n'est pas une option). */
const HEAVY_SUB: Record<string, readonly string[]> = {
  npm: ['test', 't', 'tst', 'run', 'run-script', 'rum', 'urn', 'exec', 'x', 'start'],
  pnpm: ['test', 't', 'run', 'exec', 'dlx', 'start'],
  yarn: ['test', 'run', 'exec', 'dlx', 'start'],
  bun: ['test', 'run', 'x', 'exec'],
  cargo: ['build', 'b', 'test', 't', 'check', 'c', 'clippy', 'run', 'r', 'bench', 'doc'],
  go: ['build', 'test', 'vet', 'run'],
  dotnet: ['build', 'test', 'run'],
  deno: ['test', 'task'],
  swift: ['build', 'test'],
};
/** `python -m <module>` lourds. */
const HEAVY_PY_MODULES = new Set(['pytest', 'tox', 'unittest']);
const PYTHON_RE = /^python(3(\.[0-9]+)?)?$/;

/** Noms à chercher dans une ligne avant d'appeler l'outil (préfiltre du widget zsh). */
export const HEAVY_NAMES: readonly string[] = [...HEAVY_ANY, ...Object.keys(HEAVY_SUB), 'python'].sort();

/**
 * Jamais de réécriture si la ligne en contient une : déjà enveloppée ou élévation de droits, changement d'état du shell
 * appelant (qu'un `<shell> -c` perdrait), commande interactive plein écran ou syntaxe trop délicate.
 */
const BLOCK = new Set([
  'computer-watcher', 'systemd-run', 'sudo', 'doas', 'su', 'pkexec', 'run0',
  'cd', 'pushd', 'popd', 'export', 'source', '.', 'alias', 'unalias', 'unset', 'set', 'setopt', 'unsetopt', 'shopt', 'eval', 'exec',
  'exit', 'return', 'logout', 'typeset', 'declare', 'local', 'readonly', 'integer', 'float', 'read', 'ulimit', 'limit', 'umask', 'trap',
  'fg', 'bg', 'jobs', 'wait', 'disown', 'hash', 'rehash', 'bindkey', 'zle', 'autoload', 'emulate', 'enable', 'disable', 'builtin',
  'function', 'case', 'select', 'coproc',
  'vi', 'vim', 'nvim', 'nano', 'emacs', 'emacsclient', 'micro', 'hx', 'kak', 'less', 'more', 'most', 'man', 'info',
  'ssh', 'mosh', 'tmux', 'screen', 'zellij', 'top', 'htop', 'btop', 'watch', 'fzf',
]);
/** Mots réservés sautés en tête de segment (`if make; then …`). */
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', '{', '}', '!']);

// ——— Analyse lexicale (approchée, prudente) ———

export type Token =
  | { t: 'w'; raw: string; /** texte sans quotes ; null s'il contient une expansion ($, `…`) */ lit: string | null; start: number; end: number }
  | { t: 'op'; op: string; start: number };

export interface Lexed { tokens: Token[]; heredoc: boolean; bang: boolean }

const CONTROL = ['&&', '||', ';;', '|&', ';', '|', '&', '(', ')', '\n'];
const REDIRECT = ['&>>', '<<<', '<<-', '&>', '<<', '<>', '<&', '>>', '>&', '>|', '<', '>'];
const OP_START = new Set(['&', '|', ';', '(', ')', '<', '>', '\n']);

/** Fin (exclue) de la quote simple ouverte en i, -1 si non fermée. */
const endSingle = (s: string, i: number): number => {
  const j = s.indexOf("'", i + 1);
  return j < 0 ? -1 : j + 1;
};

/** Fin d'un bloc imbriqué ouvert juste avant i (`$(`, `${`, `<(`), en tenant compte des quotes ; -1 si non fermé. */
function endNested(s: string, i: number, open: string, close: string, f: { bang: boolean }): number {
  let depth = 1;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\') i += 2;
    else if (c === "'") {
      i = endSingle(s, i);
      if (i < 0) return -1;
    } else if (c === '"') {
      i = endDouble(s, i, f);
      if (i < 0) return -1;
    } else if (c === '`') {
      i = endBacktick(s, i);
      if (i < 0) return -1;
    } else {
      if (c === '!') f.bang = true;
      if (c === open) depth++;
      else if (c === close && --depth === 0) return i + 1;
      i++;
    }
  }
  return -1;
}

function endBacktick(s: string, i: number): number {
  for (i++; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '`') return i + 1;
  }
  return -1;
}

/** Fin de la quote double ouverte en i ; -1 si non fermée. */
function endDouble(s: string, i: number, f: { bang: boolean; expand?: boolean }): number {
  for (i++; i < s.length; ) {
    const c = s[i]!;
    if (c === '\\') i += 2;
    else if (c === '"') return i + 1;
    else if (c === '`') {
      f.expand = true;
      i = endBacktick(s, i);
      if (i < 0) return -1;
    } else if (c === '$' && (s[i + 1] === '(' || s[i + 1] === '{')) {
      f.expand = true;
      i = endNested(s, i + 2, s[i + 1]!, s[i + 1] === '(' ? ')' : '}', f);
      if (i < 0) return -1;
    } else {
      if (c === '$') f.expand = true;
      if (c === '!') f.bang = true;
      i++;
    }
  }
  return -1;
}

/** Découpe une ligne en mots et opérateurs ; null si elle est incomplète (quote, substitution ou `\` final ouverts). */
export function lexLine(s: string): Lexed | null {
  const tokens: Token[] = [];
  const f = { bang: false, heredoc: false };
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '#') {
      const j = s.indexOf('\n', i);
      i = j < 0 ? s.length : j;
      continue;
    }
    if ((c === '<' || c === '>') && s[i + 1] === '(') {
      // substitution de processus <(…) >(…) : un mot
      const end = endNested(s, i + 2, '(', ')', f);
      if (end < 0) return null;
      tokens.push({ t: 'w', raw: s.slice(i, end), lit: null, start: i, end });
      i = end;
      continue;
    }
    if (OP_START.has(c)) {
      const op = [...REDIRECT, ...CONTROL].filter((o) => s.startsWith(o, i)).sort((a, b) => b.length - a.length)[0]!;
      if (op === '<<' || op === '<<-') f.heredoc = true;
      tokens.push({ t: 'op', op, start: i });
      i += op.length;
      continue;
    }
    // mot
    const start = i;
    let lit: string | null = '';
    const g = { bang: false, expand: false };
    while (i < s.length) {
      const d = s[i]!;
      if (d === ' ' || d === '\t' || d === '\r' || OP_START.has(d)) break;
      if (d === '\\') {
        if (i + 1 >= s.length) return null;
        if (s[i + 1] !== '\n' && lit !== null) lit += s[i + 1];
        i += 2;
      } else if (d === "'") {
        const e = endSingle(s, i);
        if (e < 0) return null;
        if (lit !== null) lit += s.slice(i + 1, e - 1);
        i = e;
      } else if (d === '$' && s[i + 1] === "'") {
        let e = -1;
        for (let k = i + 2; k < s.length; k++) {
          if (s[k] === '\\') k++;
          else if (s[k] === "'") {
            e = k + 1;
            break;
          }
        }
        if (e < 0) return null;
        lit = null;
        i = e;
      } else if (d === '"') {
        const before = g.expand;
        g.expand = false;
        const e = endDouble(s, i, g);
        if (e < 0) return null;
        if (g.expand) lit = null;
        else if (lit !== null) lit += s.slice(i + 1, e - 1).replace(/\\([\\"$`])/g, '$1');
        g.expand ||= before;
        i = e;
      } else if (d === '`') {
        const e = endBacktick(s, i);
        if (e < 0) return null;
        lit = null;
        i = e;
      } else if (d === '$' && (s[i + 1] === '(' || s[i + 1] === '{')) {
        const e = endNested(s, i + 2, s[i + 1]!, s[i + 1] === '(' ? ')' : '}', g);
        if (e < 0) return null;
        lit = null;
        i = e;
      } else {
        if (d === '$') lit = null;
        if (d === '!') g.bang = true;
        if (lit !== null) lit += d;
        i++;
      }
    }
    if (g.bang) f.bang = true;
    const raw = s.slice(start, i);
    // descripteur d'une redirection (2>&1) : partie de la redirection, pas un mot
    if (/^[0-9]+$/.test(raw) && (s[i] === '<' || s[i] === '>')) continue;
    tokens.push({ t: 'w', raw, lit, start, end: i });
  }
  return { tokens, heredoc: f.heredoc, bang: f.bang };
}

// ——— Décision ———

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

type Word = Extract<Token, { t: 'w' }>;
interface Segment { words: Word[]; redirectBefore: boolean }

/** Une commande (mots hors cibles de redirection) : lourde, bloquante ou neutre. */
function classify(seg: Segment): { kind: 'heavy' | 'block' | 'none'; cmd: Word | null; prefixOk: boolean } {
  const w = seg.words;
  let k = 0;
  let assigns = 0;
  let keywords = 0;
  for (; k < w.length; k++) {
    const l = w[k]!.lit;
    if (l !== null && KEYWORDS.has(l)) {
      if (l === 'for') return { kind: 'none', cmd: null, prefixOk: false }; // for x in … : pas une commande
      keywords++;
    } else if (ASSIGN_RE.test(w[k]!.raw)) assigns++;
    else break;
  }
  const cmd = w[k];
  // affectations seules : variables du shell appelant
  if (!cmd) return { kind: assigns > 0 ? 'block' : 'none', cmd: null, prefixOk: false };
  const prefixOk = keywords === 0 && !seg.redirectBefore;
  if (cmd.lit === null) return { kind: 'none', cmd, prefixOk };
  const name = baseName(cmd.lit);
  if (BLOCK.has(name) || BLOCK.has(cmd.lit)) return { kind: 'block', cmd, prefixOk };
  const args = w.slice(k + 1).map((x) => x.lit);
  let heavy = HEAVY_ANY.has(name);
  const subs = HEAVY_SUB[name];
  if (subs) {
    const sub = args.find((a) => a === null || !(a.startsWith('-') || a.startsWith('+')));
    heavy = typeof sub === 'string' && subs.includes(sub);
  }
  if (PYTHON_RE.test(name)) {
    const m = args.indexOf('-m');
    heavy = m >= 0 && HEAVY_PY_MODULES.has(args[m + 1] ?? '');
  }
  return { kind: heavy ? 'heavy' : 'none', cmd, prefixOk };
}

export type WrapPlan = { kind: 'prefix'; at: number } | { kind: 'shell' };

/** Analyse de la ligne seule (sans projet ni config). */
export function planLine(line: string): WrapPlan | null {
  const lx = lexLine(line);
  if (!lx || lx.heredoc) return null;
  const toks = lx.tokens;
  const segments: Segment[] = [];
  const ops: { op: string; index: number }[] = [];
  let cur: Segment = { words: [], redirectBefore: false };
  let depth = 0;
  let blocks = 0; // { } if/fi do/done ouverts
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.t === 'op') {
      if (REDIRECT.includes(t.op)) {
        const target = toks[i + 1];
        if (!target || target.t !== 'w') return null;
        if (cur.words.length === 0) cur.redirectBefore = true;
        i++;
        continue;
      }
      if (t.op === '(') {
        if (toks[i + 1]?.t === 'op' && (toks[i + 1] as { op: string }).op === ')') return null; // définition de fonction
        depth++;
      } else if (t.op === ')' && --depth < 0) return null;
      ops.push({ op: t.op, index: i });
      segments.push(cur);
      cur = { words: [], redirectBefore: false };
      continue;
    }
    if (cur.words.length === 0 || (cur.words.every((x) => x.lit !== null && KEYWORDS.has(x.lit)))) {
      if (t.lit === 'if' || t.lit === 'do' || t.lit === '{') blocks++;
      else if (t.lit === 'fi' || t.lit === 'done' || t.lit === '}') blocks--;
    }
    cur.words.push(t);
  }
  segments.push(cur);
  if (depth !== 0 || blocks !== 0) return null;
  // opérateur binaire sans commande d'un côté : ligne incomplète (le shell demanderait la suite)
  const firstWord = toks.findIndex((t) => t.t === 'w');
  let lastWord = -1;
  toks.forEach((t, i) => {
    if (t.t === 'w') lastWord = i;
  });
  for (const o of ops) if (['&&', '||', '|', '|&'].includes(o.op) && (o.index < firstWord || o.index > lastWord)) return null;

  const classes = segments.map(classify);
  if (classes.some((c) => c.kind === 'block')) return null;
  if (!classes.some((c) => c.kind === 'heavy')) return null;

  // commande simple (opérateurs seulement en fin : `&`, `;`, retour à la ligne) : préfixe, le reste reste au shell appelant
  const commands = classes.filter((c) => c.cmd !== null);
  const inner = ops.filter((o) => o.index < lastWord);
  if (commands.length === 1 && inner.length === 0 && !ops.some((o) => o.op === '(' || o.op === ')')) {
    const c = commands[0]!;
    if (c.prefixOk && c.kind === 'heavy') return { kind: 'prefix', at: c.cmd!.start };
  }
  // composée : la ligne entière dans <shell> -c. Jamais d'arrière-plan (le contrôle des tâches serait perdu), de `|&`,
  // ni de `!` (expansion d'historique, que les apostrophes couperaient).
  if (ops.some((o) => o.op === '&' || o.op === '|&') || lx.bang) return null;
  return { kind: 'shell' };
}

/** Le projet du dossier courant a-t-il un budget anti-gel (anti-gel allumé, config lisible) ? */
export function hasBudget(cwd: string, ctx: WrapCtx): boolean {
  if (ctx.env.CWATCH_NO_WRAP === '1' || ctx.env.PROC_WATCH_NO_ANTIGEL === '1') return false;
  if (!ctx.config || !ctx.config.enabled || !cwd.startsWith('/')) return false;
  const root = workRoot(cwd, ctx.findRoot, ctx.home);
  const key = root === null ? null : budgetKey(root);
  return key !== null && Object.hasOwn(ctx.config.budgets, key);
}

export function planWrap(command: string, cwd: string, ctx: WrapCtx): WrapPlan | null {
  if (typeof command !== 'string' || command.length > 100_000 || command.includes('\0')) return null;
  const plan = planLine(command);
  return plan !== null && hasBudget(cwd, ctx) ? plan : null;
}

/** Vrai si `command` (lancée depuis `cwd`) doit démarrer dans le budget de son projet. */
export const shouldWrap = (command: string, cwd: string, ctx: WrapCtx): boolean => planWrap(command, cwd, ctx) !== null;

export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Ligne réécrite, ou null si elle doit rester telle quelle. */
export function wrapCommand(command: string, cwd: string, ctx: WrapCtx, o: WrapOptions = {}): string | null {
  const plan = planWrap(command, cwd, ctx);
  if (!plan) return null;
  const bin = o.bin ?? 'computer-watcher';
  if (plan.kind === 'prefix') return `${command.slice(0, plan.at)}${bin} run -- ${command.slice(plan.at)}`;
  return `${bin} run -- ${o.shell ?? 'sh'} -c ${shellQuote(command.trim())}`;
}
