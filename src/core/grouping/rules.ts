// src/core/grouping/rules.ts
export const CLAUDE_NAME = 'claude';

/** Applications multi-processus regroupées par processus racine */
export const APP_NAMES = new Set([
  'chrome', 'chromium', 'firefox', 'firefox-bin', 'code', 'electron', 'spotify', 'slack', 'discord',
  'claude-desktop', 'warp', 'obsidian', 'thunderbird',
]);

/** Outils de dev regroupés par projet. Couvre aussi "node (vitest)", "node-MainThread", "npm exec vitest", "python3.12". */
export const DEV_TOOL = /^(node|npm|pnpm|yarn|bun|deno|vite|esbuild|uv|java|cargo|go|python[\d.]*)\b/;

/**
 * Outil de dev, reconnu au nom (comm), ou au programme lancé (premier mot de la ligne de commande) quand le comm vaut
 * « MainThread » : sous Node ≥ 24, c'est le comm d'un processus node (jest et ses workers, tsc, eslint…). Jamais la ligne
 * de commande pour un autre comm : un programme à shebang (`meld`, lancé comme `/usr/bin/python3 /usr/bin/meld`) garde
 * son nom de script et n'est pas un outil de dev.
 */
export function isDevTool(name: string, cmdline: string): boolean {
  if (DEV_TOOL.test(name)) return true;
  if (name !== 'MainThread' || cmdline.startsWith('[')) return false; // « [nom] » : thread noyau ou ligne de commande vide
  const first = cmdline.split(/\s+/, 1)[0] ?? '';
  const base = first.slice(first.lastIndexOf('/') + 1);
  return base !== '' && DEV_TOOL.test(base);
}

export function appLabel(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Shells (nom du processus) : ceux de l'outil Bash, enfants directs de claude, ne sont pas des outils Claude. */
export const SHELL_NAMES = new Set(['sh', 'bash', 'dash', 'zsh', 'fish', 'ksh']);

/**
 * Shell de l'outil Bash de Claude : un shell connu dont la ligne de commande charge `<config Claude>/shell-snapshots/…`
 * (`~/.claude` ou un des dossiers de config `dirs`). Tout autre enfant direct de claude, shell compris (serveur MCP lancé
 * par `bash -c`), est un outil Claude.
 */
export function isBashToolShell(p: { name: string; cmdline: string }, dirs: readonly string[]): boolean {
  return SHELL_NAMES.has(p.name) && (p.cmdline.includes('/.claude/shell-snapshots/') || dirs.some((d) => p.cmdline.includes(`${d}/shell-snapshots/`)));
}

const TEST_BROWSER_FLAG = /(^|\s)(--enable-automation|--remote-debugging-pipe|--headless(=\S*)?|-juggler-pipe)(\s|$)/;
const TEST_BROWSER_EXE = /\/(ms-playwright|\.cache\/puppeteer)\//;

/** Navigateur piloté par un outil de test (Playwright, Puppeteer…) : drapeaux d'automatisation ou exécutable de leurs caches. */
export function isTestBrowser(cmdline: string): boolean {
  if (TEST_BROWSER_FLAG.test(cmdline)) return true;
  const exe = cmdline.split(/\s+/, 1)[0] ?? '';
  return TEST_BROWSER_EXE.test(exe);
}
