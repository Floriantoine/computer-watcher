// Lancer les commandes lourdes directement dans le budget : installation en un clic (logique pure, partagée avec le renderer).
// Trois éléments : la commande `computer-watcher` dans le PATH, un bloc dans ~/.zshrc, un hook PreToolUse dans
// ~/.claude/settings.json. Ici : textes exacts, reconnaissance de ce que l'app a écrit, ajout et retrait sur du texte.
// Les fichiers sont lus et écrits par main/wrapSetup.ts.

export type WrapPart = 'command' | 'zshrc' | 'claude';
export const WRAP_PARTS: readonly WrapPart[] = ['command', 'zshrc', 'claude'];
export const isWrapPart = (x: unknown): x is WrapPart => typeof x === 'string' && (WRAP_PARTS as readonly string[]).includes(x);

/** absent / installé par l'app / présent mais pas de l'app / illisible (ou invalide). */
export type WrapItemState = 'absent' | 'ours' | 'foreign' | 'unreadable';

export interface WrapItemStatus {
  part: WrapPart;
  state: WrapItemState;
  /** Le nécessaire est en place (par l'app ou autrement) : rien à faire pour cet élément. */
  ok: boolean;
  /** Fichier concerné (affiché tel quel). */
  path: string;
  /** Texte exact que « Installer » ajoute. */
  preview: string;
  /** Une phrase sur l'état. */
  detail: string;
  canInstall: boolean;
  canRemove: boolean;
  /** Pourquoi « Installer » n'est pas possible (affiché). */
  blocked: string | null;
  warnings: string[];
}

export interface WrapSetupStatus {
  items: WrapItemStatus[];
  /** Les trois éléments sont en place. */
  complete: boolean;
}

export interface WrapActionResult {
  part: WrapPart;
  /** Le fichier a été écrit ou retiré. */
  changed: boolean;
  message: string;
  /** Sauvegarde faite avant l'écriture. */
  backup: string | null;
  warnings: string[];
}

export const WRAP_LABELS: Record<WrapPart, string> = {
  command: 'Commande computer-watcher',
  zshrc: 'Terminal zsh',
  claude: 'Claude Code',
};

// ---------------------------------------------------------------- ~/.zshrc

export const ZSHRC_LINE = '(( ${+commands[computer-watcher]} )) && eval "$(computer-watcher shell-init zsh)"';
export const ZSH_BEGIN = '# >>> computer-watcher : lancer directement dans le budget >>>';
export const ZSH_END = '# <<< computer-watcher <<<';

/** Bloc ajouté en fin de ~/.zshrc (retour à la ligne final compris). */
export const zshBlock = () =>
  [ZSH_BEGIN, '# Ajouté par Computer Watcher (Réglages → Plafond de travail) ; « Retirer » enlève ce bloc.', ZSHRC_LINE, ZSH_END, ''].join('\n');

const lines = (t: string) => t.split('\n').map((l) => l.replace(/\r$/, ''));

/** Indices (lignes) du bloc de l'app, null s'il est absent ; bloc incomplet ou désordonné : 'broken'. */
function blockRange(text: string): { begin: number; end: number } | null | 'broken' {
  const ls = lines(text);
  const begin = ls.indexOf(ZSH_BEGIN);
  const end = ls.indexOf(ZSH_END);
  if (begin < 0 && end < 0) return null;
  if (begin < 0 || end < begin) return 'broken';
  return { begin, end };
}

/** `foreign` : la ligne shell-init est là sans le bloc (installation manuelle) ; `broken` : marqueur sans son pendant. */
export function zshrcState(text: string): 'absent' | 'ours' | 'foreign' | 'broken' {
  const r = blockRange(text);
  if (r === 'broken') return 'broken';
  if (r) return 'ours';
  return lines(text).some((l) => !/^\s*#/.test(l) && l.includes('computer-watcher shell-init')) ? 'foreign' : 'absent';
}

/** Ajoute le bloc à la fin (séparé par une ligne vide) ; déjà présent : texte inchangé. */
export function addZshBlock(text: string): string {
  const s = zshrcState(text);
  if (s === 'ours') return text;
  if (s === 'broken') throw new Error('bloc computer-watcher incomplet dans ~/.zshrc : à corriger à la main');
  if (text === '') return zshBlock();
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const block = zshBlock().replace(/\n/g, nl);
  return `${text}${text.endsWith('\n') ? '' : nl}${nl}${block}`;
}

/** Retire le bloc (et la ligne vide ajoutée avant lui) ; absent : texte inchangé. */
export function removeZshBlock(text: string): string {
  const r = blockRange(text);
  if (r === null) return text;
  if (r === 'broken') throw new Error('bloc computer-watcher incomplet dans ~/.zshrc : rien retiré (à corriger à la main)');
  const raw = text.split('\n');
  let from = r.begin;
  if (from > 0 && raw[from - 1]!.replace(/\r$/, '') === '') from--;
  const out = [...raw.slice(0, from), ...raw.slice(r.end + 1)];
  return out.join('\n');
}

// ---------------------------------------------------------------- ~/.claude/settings.json

export const CLAUDE_HOOK_COMMAND = 'computer-watcher claude-hook';
export const CLAUDE_HOOK_ENTRY = { matcher: 'Bash', hooks: [{ type: 'command', command: CLAUDE_HOOK_COMMAND, timeout: 5 }] } as const;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const isOurs = (e: unknown) => deepEqual(e, CLAUDE_HOOK_ENTRY);
const isObj = (x: unknown): x is Record<string, Json> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Contenu lu et vérifié : objet racine, `hooks` objet s'il existe, `hooks.PreToolUse` tableau s'il existe. */
function parseSettings(text: string | null): Record<string, Json> {
  if (text === null || text.trim() === '') return {};
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON invalide (${e instanceof Error ? e.message : String(e)}) : rien n’est modifié`);
  }
  if (!isObj(j)) throw new Error('contenu inattendu (pas un objet JSON) : rien n’est modifié');
  if (j.hooks !== undefined && !isObj(j.hooks)) throw new Error('contenu inattendu (« hooks » n’est pas un objet) : rien n’est modifié');
  if (isObj(j.hooks) && j.hooks.PreToolUse !== undefined && !Array.isArray(j.hooks.PreToolUse)) {
    throw new Error('contenu inattendu (« hooks.PreToolUse » n’est pas une liste) : rien n’est modifié');
  }
  return j;
}

/** Indentation du fichier (2 espaces par défaut, tabulation reconnue). */
function indentOf(text: string | null): string | number {
  const m = text?.match(/^\{\s*?\n([ \t]+)"/);
  if (!m) return 2;
  return m[1]!.includes('\t') ? '\t' : m[1]!.length;
}

function serialize(j: unknown, original: string | null): string {
  const flat = original !== null && original.trim() !== '' && !/\n/.test(original.trim());
  const body = flat ? JSON.stringify(j) : JSON.stringify(j, null, indentOf(original));
  const nl = original === null || original.trim() === '' || original.endsWith('\n') ? '\n' : '';
  return body + nl;
}

/** `invalid` : JSON illisible ou structure inattendue ; `foreign` : un hook appelle déjà claude-hook sous une autre forme. */
export function claudeHookState(text: string | null): 'absent' | 'ours' | 'foreign' | 'invalid' {
  let j: Record<string, Json>;
  try {
    j = parseSettings(text);
  } catch {
    return 'invalid';
  }
  const pre = isObj(j.hooks) && Array.isArray(j.hooks.PreToolUse) ? j.hooks.PreToolUse : [];
  if (pre.some(isOurs)) return 'ours';
  const calls = (e: Json) => isObj(e) && Array.isArray(e.hooks) && e.hooks.some((h) => isObj(h) && typeof h.command === 'string' && h.command.includes(CLAUDE_HOOK_COMMAND));
  return pre.some(calls) ? 'foreign' : 'absent';
}

/** Ajoute notre entrée à la fin de hooks.PreToolUse ; le reste (clés, ordre) est conservé. Déjà là : inchangé. */
export function addClaudeHook(text: string | null): string {
  const j = parseSettings(text);
  const hooks = isObj(j.hooks) ? j.hooks : {};
  const pre = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  if (pre.some(isOurs)) return text!;
  hooks.PreToolUse = [...pre, structuredClone(CLAUDE_HOOK_ENTRY) as unknown as Json];
  j.hooks = hooks;
  return serialize(j, text);
}

/** Retire exactement notre entrée ; une liste ou un objet `hooks` vidés par ce retrait sont enlevés. Absente : inchangé. */
export function removeClaudeHook(text: string): string {
  const j = parseSettings(text);
  if (!isObj(j.hooks) || !Array.isArray(j.hooks.PreToolUse) || !j.hooks.PreToolUse.some(isOurs)) return text;
  const rest = j.hooks.PreToolUse.filter((e) => !isOurs(e));
  if (rest.length) j.hooks.PreToolUse = rest;
  else {
    delete j.hooks.PreToolUse;
    if (Object.keys(j.hooks).length === 0) delete j.hooks;
  }
  return serialize(j, text);
}

// ---------------------------------------------------------------- lanceur ~/.local/bin/computer-watcher

export const LAUNCHER_MARKER = '# computer-watcher-launcher : écrit par Computer Watcher';

/** Programme appelé par le lanceur : l'AppImage (chemin figé), le binaire de l'app, ou Electron en mode Node (développement). */
export type LauncherTarget = { kind: 'appimage' | 'binary'; path: string } | { kind: 'node'; electron: string; cli: string };

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function launcherScript(t: LauncherTarget): string {
  const run = t.kind === 'node' ? `ELECTRON_RUN_AS_NODE=1 exec ${shq(t.electron)} ${shq(t.cli)} "$@"` : `exec ${shq(t.path)} "$@"`;
  return [
    '#!/bin/sh',
    LAUNCHER_MARKER,
    '# (Réglages → Plafond de travail ; « Retirer » le supprime). Sert run, should-wrap, shell-init et claude-hook.',
    run,
    '',
  ].join('\n');
}

export const isOurLauncher = (text: string) => lines(text).includes(LAUNCHER_MARKER);

/** Fichier visé par le lanceur (null si illisible). */
export function launcherTargetPath(text: string): string | null {
  const m = text.match(/exec '((?:[^']|'\\'')*)'/);
  return m ? m[1]!.replace(/'\\''/g, "'") : null;
}

// ---------------------------------------------------------------- sauvegardes

const pad = (n: number) => String(n).padStart(2, '0');

/** `<fichier>.computer-watcher-AAAAMMJJ-HHMMSS.bak` (heure locale), à côté du fichier. */
export function backupName(path: string, d: Date): string {
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${path}.computer-watcher-${stamp}.bak`;
}

// ---------------------------------------------------------------- rappel au lancement

/** Réponse gardée dans wrap-setup.json : « Ne plus afficher », ou installation complète constatée. */
export type WrapReminderAnswer = 'never' | 'done';

export function shouldRemind(o: {
  antigelEnabled: boolean; complete: boolean; answer: WrapReminderAnswer | null; later: boolean; testMode: boolean; onboarding: boolean;
}): boolean {
  return o.antigelEnabled && !o.complete && o.answer === null && !o.later && !o.testMode && !o.onboarding;
}

/** wrap-setup.json → réponse ; illisible : null (le rappel revient). */
export function parseReminderFile(text: string | null): WrapReminderAnswer | null {
  if (text === null) return null;
  try {
    const j = JSON.parse(text) as { version?: unknown; reminder?: unknown };
    return j.version === 1 && (j.reminder === 'never' || j.reminder === 'done') ? j.reminder : null;
  } catch {
    return null;
  }
}

export const serializeReminderFile = (a: WrapReminderAnswer) => `${JSON.stringify({ version: 1, reminder: a })}\n`;

/** App lancée par un test (variables PROC_WATCH_NO_*, e2e) : jamais de rappel, sauf PROC_WATCH_WRAP_REMINDER=1. */
export function isTestLaunch(env: NodeJS.ProcessEnv): boolean {
  if (env.PROC_WATCH_WRAP_REMINDER === '1') return false;
  return Object.keys(env).some((k) => k.startsWith('PROC_WATCH_NO_') || (k.startsWith('PROC_WATCH_') && k.endsWith('_E2E'))) || env.PROC_WATCH_E2E === '1';
}
