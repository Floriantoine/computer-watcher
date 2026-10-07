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
