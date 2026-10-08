// src/core/rules/neverKill.ts — liste « jamais tuer » des règles automatiques, codée en dur (indépendante de la liste
// protégée modifiable). Appliquée par le moteur ET de nouveau juste avant chaque signal (ruleRunner).

/**
 * Noms exacts (champ Name de /proc/<pid>/status, 15 caractères au plus, casse comprise, comme earlyoom) ou regex.
 * Claude, terminaux et shells, bureau (KWin, Plasma, X, gestionnaire de connexion), systemd, D-Bus, son, earlyoom, proc-watch.
 */
export const NEVER_KILL: readonly (string | RegExp)[] = [
  // Claude
  'claude', 'claude-desktop',
  // terminaux
  'warp', 'warp-terminal', 'konsole', 'yakuake', 'gnome-terminal-', 'gnome-terminal', 'kitty', 'alacritty', 'wezterm',
  'wezterm-gui', 'ghostty', 'foot', 'xterm', 'tilix', 'terminator', 'tmux: server', 'tmux', 'screen',
  // shells
  'bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh', 'nu',
  // bureau
  'kwin_wayland', 'kwin_wayland_wr', 'kwin_x11', 'plasmashell', 'ksmserver', 'Xwayland', 'Xorg', 'sddm', 'gdm', 'gnome-shell',
  /^sddm/, /^kded/, /^xdg-desktop-por/,
  // système
  'init', 'login', 'sshd', 'agetty', 'earlyoom', 'polkitd', 'wireplumber', 'pulseaudio',
  /^systemd/, /^dbus/, /^pipewire/,
  // proc-watch
  'proc-watch',
];

const EXACT = new Set(NEVER_KILL.filter((e): e is string => typeof e === 'string'));
const REGEXES = NEVER_KILL.filter((e): e is RegExp => e instanceof RegExp);

/** Noms de Claude : leurs descendants sont aussi « jamais tuer » (outils, serveurs MCP, outils de dev lancés par Claude). */
export const CLAUDE_NAMES: ReadonlySet<string> = new Set(['claude', 'claude-desktop']);

/** Segment de chemin `proc-watch…` dans la ligne de commande : l'app (empaquetée, AppImage, dev) ou son service. */
const PROC_WATCH_PATH = /(^|[\s/=])proc-watch[^\s/]*(\/|\s|$)/;
const RECORDER_SCRIPT = /(^|[\s/])recorder\.js(\s|$)/;
const CLAUDE_CMD = /(^|[\s/])(claude|claude-desktop)(\s|$)/;

export function isNeverKillName(name: string): boolean {
  return EXACT.has(name) || REGEXES.some((r) => r.test(name));
}

/**
 * Nom exact (ou regex) de la liste, ou ligne de commande qui lance l'app proc-watch elle-même (`appRoot`, ou un chemin
 * `…/proc-watch…`), son service (`recorder.js`) ou Claude.
 */
export function isNeverKill(p: { name: string; cmdline: string }, appRoot: string | null): boolean {
  if (isNeverKillName(p.name)) return true;
  const cmd = p.cmdline;
  if (PROC_WATCH_PATH.test(cmd) || RECORDER_SCRIPT.test(cmd) || CLAUDE_CMD.test(cmd.split(/\s+/, 1)[0] ?? '')) return true;
  if (appRoot) {
    const root = appRoot.replace(/\/+$/, '');
    if (root.length > 1 && cmd.split(/\s+/).some((a) => a.replace(/^--[\w-]+=/, '') === root || a.replace(/^--[\w-]+=/, '').startsWith(`${root}/`))) return true;
  }
  return false;
}

export interface GuardProc { pid: number; ppid: number; name: string; cmdline: string; uid: number }

export interface GuardContext {
  /** Tous les processus connus (pour remonter les ancêtres et trouver les descendants). */
  byPid: ReadonlyMap<number, GuardProc>;
  currentUid: number;
  selfPid: number;
  appRoot: string | null;
  isProtected: (name: string) => boolean;
}

export type GuardReason = 'never-kill' | 'claude' | 'protected' | 'root' | 'uid' | 'self' | 'unknown' | 'launcher';

const isClaude = (p: GuardProc) => CLAUDE_NAMES.has(p.name) || CLAUDE_CMD.test(p.cmdline.split(/\s+/, 1)[0] ?? '');

/** Raison propre au processus lui-même (sans regarder ses descendants). */
function ownReason(pid: number, ctx: GuardContext, selfChain: ReadonlySet<number>): GuardReason | null {
  if (!Number.isInteger(pid) || pid <= 1) return 'self';
  const p = ctx.byPid.get(pid);
  if (!p) return 'unknown';
  if (p.uid === 0) return 'root';
  if (p.uid !== ctx.currentUid) return 'uid';
  if (selfChain.has(pid)) return 'self';
  if (isNeverKill(p, ctx.appRoot)) return 'never-kill';
  if (ctx.isProtected(p.name)) return 'protected';
  // ancêtre Claude (session, outil, outil de dev lancé par Claude) ou proc-watch (fenêtres de l'app)
  const seen = new Set<number>([pid]);
  for (let cur = ctx.byPid.get(p.ppid); cur && !seen.has(cur.pid); cur = ctx.byPid.get(cur.ppid)) {
    seen.add(cur.pid);
    if (isClaude(cur)) return 'claude';
    if (cur.pid === ctx.selfPid || cur.name === 'proc-watch' || PROC_WATCH_PATH.test(cur.cmdline)) return 'self';
  }
  return null;
}

/** proc-watch (le service) et ses ancêtres. */
function selfChainOf(ctx: GuardContext): Set<number> {
  const out = new Set<number>([ctx.selfPid]);
  for (let cur = ctx.byPid.get(ctx.selfPid); cur && !out.has(cur.ppid) && cur.ppid > 0; cur = ctx.byPid.get(cur.ppid)) out.add(cur.ppid);
  return out;
}

/**
 * Filtre des cibles d'une règle : retire chaque processus « jamais tuer » (liste, Claude et ses descendants, protégés,
 * root, autres utilisateurs, proc-watch et ses ancêtres, inconnu), et tout processus dont un descendant est retiré
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
