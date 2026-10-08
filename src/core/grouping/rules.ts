// src/core/grouping/rules.ts
export const CLAUDE_NAME = 'claude';

/** Applications multi-processus regroupées par processus racine */
export const APP_NAMES = new Set([
  'chrome', 'chromium', 'firefox', 'firefox-bin', 'code', 'electron', 'spotify', 'slack', 'discord',
  'claude-desktop', 'warp', 'obsidian', 'thunderbird',
]);

/** Outils de dev regroupés par projet. Couvre aussi "node (vitest)", "node-MainThread", "npm exec vitest", "python3.12". */
export const DEV_TOOL = /^(node|npm|pnpm|yarn|bun|deno|vite|esbuild|uv|java|cargo|go|python[\d.]*)\b/;

export function appLabel(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Shells (nom du processus) : ceux de l'outil Bash, enfants directs de claude, ne sont pas des outils Claude. */
export const SHELL_NAMES = new Set(['sh', 'bash', 'dash', 'zsh', 'fish', 'ksh']);

const TEST_BROWSER_FLAG = /(^|\s)(--enable-automation|--remote-debugging-pipe|--headless(=\S*)?|-juggler-pipe)(\s|$)/;
const TEST_BROWSER_EXE = /\/(ms-playwright|\.cache\/puppeteer)\//;

/** Navigateur piloté par un outil de test (Playwright, Puppeteer…) : drapeaux d'automatisation ou exécutable de leurs caches. */
export function isTestBrowser(cmdline: string): boolean {
  if (TEST_BROWSER_FLAG.test(cmdline)) return true;
  const exe = cmdline.split(/\s+/, 1)[0] ?? '';
  return TEST_BROWSER_EXE.test(exe);
}
