// src/core/rules/neverKill.ts — liste « jamais tuer » des règles automatiques, codée en dur (indépendante de la liste
// protégée modifiable). Appliquée par le moteur ET de nouveau juste avant chaque signal (ruleRunner).

import { APP_SELF_NAMES } from '../appName';

/** Longueur maximale du nom d'un processus (comm, TASK_COMM_LEN − 1) : au-delà, le noyau tronque. */
export const COMM_MAX = 15;

/**
 * Services de la session de bureau et du système (KWin, Plasma, X, portails, KWallet, PipeWire, D-Bus, systemd, earlyoom…) :
 * source unique, partagée par les règles automatiques (liste « jamais tuer ») et la vue swap (jamais d'« Arrêter »).
 * Noms exacts (champ Name de /proc/<pid>/status, 15 caractères au plus, casse comprise, comme earlyoom) ou regex.
 */
export const SESSION_SERVICES: readonly (string | RegExp)[] = [
  // bureau et session (KDE, GNOME, X), démons de session
  'kwin_wayland', 'kwin_wayland_wr', 'kwin_wayland_wrapper', 'kwin_x11', 'plasmashell', 'ksmserver', 'Xwayland', 'Xorg', 'sddm', 'gdm', 'gnome-shell',
  'kactivitymanagerd', 'dconf-service', 'xembedsniproxy', 'gmenudbusmenuproxy', 'kaccess', 'gpg-agent', 'ssh-agent',
  /^sddm/, /^kwin/, /^plasma/, /^startplasma/, /^kscreen/, /^kwallet/, /^ksecret/, /^polkit/, /^xdg-/, /^at-spi/, /^gpg-agent/, /^ssh-agent/,
  /^krunner/, /^kded/, /^kdeconnect/, /^baloo/, /^gvfs/, /^ibus/, /^fcitx/, /^org_kde_/, /^kglobalaccel/, /^kiod/, /^gnome-session/, /^gsd-/,
  // système
  'init', 'login', 'sshd', 'agetty', 'earlyoom', 'polkitd', 'wireplumber', 'pulseaudio',
  /^systemd/, /^dbus/, /^pipewire/,
];

/** Terminaux (comm exact, 15 caractères au plus) : jamais tués ; pour l'anti-gel, ce qu'ils lancent est du travail. */
export const TERMINAL_NAMES: readonly string[] = [
  'warp', 'warp-terminal', 'konsole', 'yakuake', 'gnome-terminal-', 'gnome-terminal', 'gnome-terminal-server', 'kitty', 'alacritty', 'wezterm',
  'wezterm-gui', 'ghostty', 'foot', 'xterm', 'tilix', 'terminator', 'tmux: server', 'tmux', 'screen',
];

/** Éditeurs et IDE (anti-gel : jamais déplacés ; ce qu'ils lancent, tsserver ou tests, est du travail). */
export const IDE_NAMES: readonly string[] = [
  'code', 'code-oss', 'codium', 'vscodium', 'cursor', 'zed', 'zed-editor', 'windsurf', 'sublime_text', 'kate',
  'idea', 'webstorm', 'pycharm', 'phpstorm', 'goland', 'clion', 'rider', 'rustrover', 'android-studio',
];

/** Shells (comm exact) : jamais tués ; pour l'anti-gel, jamais racine déplacée mais ils suivent leur parent. */
export const SHELL_COMMS: readonly string[] = ['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh', 'nu'];

/** Liste « jamais tuer » des règles : services de session, plus Claude, terminaux, shells et l'app (nouveau et ancien nom). */
export const NEVER_KILL: readonly (string | RegExp)[] = [
  // Claude
  'claude', 'claude-desktop',
  // terminaux
  ...TERMINAL_NAMES,
  // shells
  ...SHELL_COMMS,
  ...SESSION_SERVICES,
  // l'app elle-même : computer-watcher, son comm tronqué computer-watche, et l'ancien nom proc-watch
  ...APP_SELF_NAMES,
];

/** Correspondance d'une liste : nom exact, regex, ou nom de 15 caractères (peut-être tronqué) qui commence un nom plus long. */
function matcher(list: readonly (string | RegExp)[]): (name: string) => boolean {
  const exact = new Set(list.filter((e): e is string => typeof e === 'string'));
  const regexes = list.filter((e): e is RegExp => e instanceof RegExp);
  const long = [...exact].filter((e) => e.length > COMM_MAX);
  return (name) => exact.has(name) || regexes.some((r) => r.test(name)) || (name.length === COMM_MAX && long.some((e) => e.startsWith(name)));
}

/** Noms de Claude : leurs descendants sont aussi « jamais tuer » (outils, serveurs MCP, outils de dev lancés par Claude). */
export const CLAUDE_NAMES: ReadonlySet<string> = new Set(['claude', 'claude-desktop']);

/**
 * Segment de chemin `computer-watcher…` ou `proc-watch…` (ancien nom) dans la ligne de commande : l'app (empaquetée,
 * AppImage, dev) ou son service. Même forme qu'avant le renommage, pour chacun des deux noms.
 */
export const APP_PATH = /(^|[\s/=])(computer-watcher|proc-watch)[^\s/]*(\/|\s|$)/;
const RECORDER_SCRIPT = /(^|[\s/])recorder\.js(\s|$)/;
const CLAUDE_CMD = /(^|[\s/])(claude|claude-desktop)(\s|$)/;

const terminalName = matcher(TERMINAL_NAMES);
const ideName = matcher(IDE_NAMES);
export const isTerminalName = (name: string): boolean => terminalName(name);
export const isIdeName = (name: string): boolean => ideName(name);
/** Éditeurs basés sur Electron, seuls à exécuter des scripts Node sous leur propre nom (ELECTRON_RUN_AS_NODE). */
const ELECTRON_IDE = /^(code|code-oss|codium|vscodium|cursor|windsurf)$/;
/** Script installé avec l'éditeur : `…/resources/app/…`, ou sous /usr/lib, /usr/share ou /opt dans un dossier de l'éditeur. */
const IDE_SCRIPT_DIR = /(\/resources\/app\/|^\/(usr\/lib|usr\/share|opt)\/(code|code-oss|codium|vscodium|cursor|windsurf|visual-studio-code)[^/]*\/)/;
/**
 * Éditeur basé sur Electron qui exécute un script Node (ELECTRON_RUN_AS_NODE : tsserver, serveurs de langage de VS Code,
 * comm « code ») : premier argument = chemin absolu en .js, .mjs ou .cjs, situé dans le dossier de l'éditeur, ou lancé
 * directement par l'éditeur (`parent` : hôte d'extensions). Ce n'est pas l'éditeur, c'est du travail. Jamais kate, zed…,
 * ni un éditeur ouvert sur un fichier (`code dist/server.js`, chemin relatif ou hors de l'éditeur, depuis un shell).
 */
export const isIdeNodeScript = (p: { name: string; cmdline: string }, parent?: { name: string; cmdline: string }): boolean => {
  if (!ELECTRON_IDE.test(p.name)) return false;
  const script = p.cmdline.split(/\s+/)[1] ?? '';
  if (!script.startsWith('/') || script.split('/').includes('..') || !/\.[cm]?js$/.test(script)) return false;
  return IDE_SCRIPT_DIR.test(script) || (parent !== undefined && isIdeProc(parent));
};
/** IntelliJ (ancien lancement) : java dont la commande contient `com.intellij.` ou, hors de l'exécutable, un chemin JetBrains. */
const isJetBrainsJava = (p: { name: string; cmdline: string }): boolean => {
  const [exe = '', ...args] = p.cmdline.split(/\s+/);
  if (p.name !== 'java' && exe.slice(exe.lastIndexOf('/') + 1) !== 'java') return false;
  return args.some((a) => /(^|[=:])com\.intellij\./.test(a) || /\/jetbrains\//i.test(a));
};
/**
 * Éditeur ou IDE (anti-gel : ancre, jamais déplacé), d'après son nom, ou IntelliJ lancé par java ; jamais un script Node
 * qu'il exécute (`parent` : processus parent, s'il est connu).
 */
export function isIdeProc(p: { name: string; cmdline: string }, parent?: { name: string; cmdline: string }): boolean {
  return (ideName(p.name) && !isIdeNodeScript(p, parent)) || isJetBrainsJava(p);
}
/** Claude, d'après son nom ou le programme lancé (premier mot de la ligne de commande). */
export const isClaudeProc = (p: { name: string; cmdline: string }): boolean =>
  CLAUDE_NAMES.has(p.name) || CLAUDE_CMD.test(p.cmdline.split(/\s+/, 1)[0] ?? '');

const neverKillName = matcher(NEVER_KILL);
const sessionServiceName = matcher(SESSION_SERVICES);

/**
 * Nom exact ou regex de la liste ; un nom de 15 caractères (peut-être tronqué) est aussi couvert s'il commence un nom
 * plus long de la liste (« gmenudbusmenupr » → gmenudbusmenuproxy).
 */
export function isNeverKillName(name: string): boolean {
  return neverKillName(name);
}

/** Service de la session de bureau ou du système (vue swap : jamais d'« Arrêter » ; règles : jamais tué). */
export function isSessionService(name: string): boolean {
  return sessionServiceName(name);
}

/**
 * Nom exact (ou regex) de la liste, ou ligne de commande qui lance l'app elle-même (`appRoot`, ou un chemin
 * `…/computer-watcher…` ou `…/proc-watch…`), son service (`recorder.js`) ou Claude.
 */
export function isNeverKill(p: { name: string; cmdline: string }, appRoot: string | null): boolean {
  if (isNeverKillName(p.name)) return true;
  const cmd = p.cmdline;
  if (APP_PATH.test(cmd) || RECORDER_SCRIPT.test(cmd) || CLAUDE_CMD.test(cmd.split(/\s+/, 1)[0] ?? '')) return true;
  if (appRoot) {
    const root = appRoot.replace(/\/+$/, '');
    if (root.length > 1 && cmd.split(/\s+/).some((a) => a.replace(/^--[\w-]+=/, '') === root || a.replace(/^--[\w-]+=/, '').startsWith(`${root}/`))) return true;
  }
  return false;
}

/** Comme grouping/claudeDirs.isUnderAny, sans import Node (ce module sert aussi au renderer). */
const isUnderAny = (path: string, dirs: readonly string[]) => dirs.some((d) => path === d || path.startsWith(d.endsWith('/') ? d : `${d}/`));

export interface GuardProc { pid: number; ppid: number; name: string; cmdline: string; uid: number; cwd?: string | null }

export interface GuardContext {
  /** Tous les processus connus (pour remonter les ancêtres et trouver les descendants). */
  byPid: ReadonlyMap<number, GuardProc>;
  currentUid: number;
  selfPid: number;
  appRoot: string | null;
  isProtected: (name: string) => boolean;
  /** Dossiers de config de Claude (chemins réels) : un processus qui y travaille, ou un de ses descendants, est à Claude. */
  claudeDirs?: readonly string[];
  /** Pids du groupe Claude du dernier instantané (outils détachés compris). */
  claudePids?: ReadonlySet<number>;
  /**
   * Anti-gel lot 3 : processus d'un projet « au frigo » (gelés). Jamais visés : l'utilisateur les a mis de côté, un SIGTERM
   * resterait en attente jusqu'au réveil, et « inactif depuis T » les viserait à tort.
   */
  frozen?: ReadonlySet<number>;
  /**
   * Règle anti-gel (saturation) seulement : vérifications (tests, tsc, eslint) et leurs descendants, voir verification.ts.
   * Pour ces pids, être lancé par Claude ou rangé dans son groupe n'est plus un refus (accord de l'utilisateur du
   * 2026-10-19) ; Claude lui-même, un dossier de travail sous ses dossiers et toutes les autres raisons restent des refus.
   */
  verification?: ReadonlySet<number>;
}

export type GuardReason = 'never-kill' | 'claude' | 'protected' | 'root' | 'uid' | 'self' | 'unknown' | 'launcher' | 'frozen';

const isClaudeItself = (p: GuardProc, ctx: GuardContext) =>
  isClaudeProc(p) || (!!ctx.claudeDirs?.length && !!p.cwd && isUnderAny(p.cwd, ctx.claudeDirs));
const isClaude = (p: GuardProc, ctx: GuardContext) => isClaudeItself(p, ctx) || !!ctx.claudePids?.has(p.pid);

/** Raison propre au processus lui-même (sans regarder ses descendants). */
function ownReason(pid: number, ctx: GuardContext, selfChain: ReadonlySet<number>): GuardReason | null {
  if (!Number.isInteger(pid) || pid <= 1) return 'self';
  const p = ctx.byPid.get(pid);
  if (!p) return 'unknown';
  if (ctx.frozen?.has(pid)) return 'frozen';
  if (p.uid === 0) return 'root';
  if (p.uid !== ctx.currentUid) return 'uid';
  if (selfChain.has(pid)) return 'self';
  if (isNeverKill(p, ctx.appRoot)) return 'never-kill';
  if (ctx.isProtected(p.name)) return 'protected';
  const verification = !!ctx.verification?.has(pid);
  if (verification ? isClaudeItself(p, ctx) : isClaude(p, ctx)) return 'claude';
  // ancêtre Claude (session, outil, outil de dev lancé par Claude) ou l'app (fenêtres de l'app, sous ses deux noms) ; un ancêtre absent
  // de la lecture (course, entrée illisible) : refus, on ne sait pas qui est au-dessus
  const seen = new Set<number>([pid]);
  let cur: GuardProc = p;
  while (cur.ppid > 1) {
    const parent = ctx.byPid.get(cur.ppid);
    if (!parent) return 'unknown';
    if (seen.has(parent.pid)) return 'unknown';
    seen.add(parent.pid);
    if (!verification && isClaude(parent, ctx)) return 'claude';
    if (parent.pid === ctx.selfPid || APP_SELF_NAMES.includes(parent.name) || APP_PATH.test(parent.cmdline)) return 'self';
    cur = parent;
  }
  return null;
}

/** L'app (le service) et ses ancêtres. */
function selfChainOf(ctx: GuardContext): Set<number> {
  const out = new Set<number>([ctx.selfPid]);
  for (let cur = ctx.byPid.get(ctx.selfPid); cur && !out.has(cur.ppid) && cur.ppid > 0; cur = ctx.byPid.get(cur.ppid)) out.add(cur.ppid);
  return out;
}

/**
 * Filtre des cibles d'une règle : retire chaque processus « jamais tuer » (liste, Claude et ses descendants, protégés,
 * root, autres utilisateurs, l’app et ses ancêtres, inconnu), et tout processus dont un descendant est retiré
 * (un signal au lanceur atteindrait ce descendant). Renvoie les pids gardés et la raison de chaque retrait.
 */
export function filterTargets(pids: readonly number[], ctx: GuardContext): { kept: number[]; refused: Map<number, GuardReason> } {
  const selfChain = selfChainOf(ctx);
  const children = new Map<number, number[]>();
  for (const p of ctx.byPid.values()) if (p.ppid !== p.pid) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
  const refused = new Map<number, GuardReason>();
  const reasonMemo = new Map<number, GuardReason | null>();
  const reason = (pid: number) => {
    if (!reasonMemo.has(pid)) reasonMemo.set(pid, ownReason(pid, ctx, selfChain));
    return reasonMemo.get(pid)!;
  };
  const kept: number[] = [];
  for (const pid of new Set(pids)) {
    const own = reason(pid);
    if (own) {
      refused.set(pid, own);
      continue;
    }
    // un descendant intouchable (shell, Claude, protégé…) : le lanceur reste aussi
    let blocked = false;
    const stack = [...(children.get(pid) ?? [])];
    const seen = new Set<number>([pid]);
    while (stack.length && !blocked) {
      const c = stack.pop()!;
      if (seen.has(c)) continue;
      seen.add(c);
      const r = reason(c);
      if (r) blocked = true;
      else stack.push(...(children.get(c) ?? []));
    }
    if (blocked) refused.set(pid, 'launcher');
    else kept.push(pid);
  }
  return { kept, refused };
}
