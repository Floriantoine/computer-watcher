import type { Category } from './categories';
import type { CommandMatch } from './match';
import { baseName, programIndex, splitArgs } from './argv';

export type { CommandMatch } from './match';

interface Ctx {
  argv: string[];   // basenames
  raw: string[];    // tokens d'origine
  name: string;
  cmd: string;      // programme significatif (basename, sans extension script)
  rawCmd: string;   // programme significatif, chemin d'origine
  rest: string[];   // arguments après le programme (basenames)
  rawRest: string[]; // idem, chemins d'origine
}

interface Rule {
  category: Category;
  label: string | ((c: Ctx) => string);
  test: (c: Ctx) => boolean;
}

const stripExt = (s: string): string => s.replace(/\.(m?js|cjs|ts|py)$/, '');
const has = (c: Ctx, ...xs: string[]) => c.rest.some((a) => xs.includes(a));
const is = (c: Ctx, ...xs: string[]) => xs.includes(c.cmd);
const SERVER_ENTRY = /(^|\/)(src|dist|build)\/(main|server|index|app)(\.[cm]?[jt]s)?$/;
const BARE_ENTRY = /(^|\/)(main|server|index|app)\.[cm]?[jt]s$/;
// Sous-commande vite : premier argument non-option, en sautant les valeurs d'options connues.
const VITE_VALUE_OPTS = new Set(['--mode', '-m', '--config', '-c', '--outDir', '--base', '--host', '--port', '--logLevel', '-l', '--root']);
const viteSub = (c: Ctx): string | undefined => {
  for (let i = 0; i < c.rawRest.length; i++) {
    const a = c.rawRest[i];
    if (a.startsWith('-')) { if (!a.includes('=') && VITE_VALUE_OPTS.has(a)) i++; continue; }
    return a;
  }
  return undefined;
};
const BROWSER = /^(chrome|chromium|chromium-browser|google-chrome|firefox|brave|msedge)([-_].*)?$/;

export const COMMAND_RULES: Rule[] = [
  // ai d'abord : « claude » et serveurs MCP
  { category: 'ai', label: 'claude', test: (c) => is(c, 'claude', 'claude-desktop') || c.name === 'claude' || c.name === 'claude-desktop' },
  { category: 'ai', label: (c) => (c.cmd === 'cli' ? c.rawCmd.split('/').slice(-3, -1).join('/') : stripExt(c.cmd)), test: (c) => /^(.+-mcp|mcp-server-.+)$/.test(c.cmd) || /(^|\/)@[^/]+\/mcp\/cli(\.[cm]?js)?$/.test(c.rawCmd) },
  // test avant front (vitest) et build
  { category: 'test', label: (c) => c.cmd, test: (c) => is(c, 'vitest', 'jest', 'cypress', 'pytest', 'mocha', 'karma') },
  { category: 'test', label: 'playwright test', test: (c) => (c.cmd === 'playwright' || /(^|\/)playwright(-core)?\/cli(\.[cm]?js)?$/.test(c.rawCmd)) && c.rest[0] === 'test' },
  // build
  { category: 'build', label: 'vite build', test: (c) => c.cmd === 'vite' && (viteSub(c) === 'build' || viteSub(c) === 'optimize') },
  { category: 'build', label: 'tsc --watch', test: (c) => c.cmd === 'tsc' && has(c, '-w', '--watch') },
  { category: 'build', label: 'esbuild --watch', test: (c) => c.cmd === 'esbuild' && c.rest.some((a) => a === '--watch' || a.startsWith('--watch=')) },
  { category: 'build', label: 'tsserver', test: (c) => /(^|\/)tsserver(\.js)?$/.test(c.rawCmd) || c.cmd === 'tsserver' },
  { category: 'build', label: (c) => c.cmd, test: (c) => is(c, 'eslint_d', 'prettierd', 'typescript-language-server', 'gopls', 'pyright', 'pyright-langserver', 'rust-analyzer') },
  { category: 'build', label: 'turbo daemon', test: (c) => c.cmd === 'turbo' && has(c, 'daemon') },
  { category: 'build', label: 'nx daemon', test: (c) => c.cmd === 'nx' && has(c, 'daemon') },
  // front
  { category: 'front', label: 'vite preview', test: (c) => c.cmd === 'vite' && viteSub(c) === 'preview' },
  { category: 'front', label: 'vite', test: (c) => c.cmd === 'vite' },
  { category: 'front', label: (c) => `next ${c.rest[0]}`, test: (c) => c.cmd === 'next' && (c.rest[0] === 'dev' || c.rest[0] === 'start') },
  { category: 'front', label: 'next dev', test: (c) => c.cmd.startsWith('next-server') },
  { category: 'front', label: 'nuxt', test: (c) => c.cmd === 'nuxt' || c.cmd === 'nuxi' },
  { category: 'front', label: 'astro dev', test: (c) => c.cmd === 'astro' && (c.rest.length === 0 || c.rest[0] === 'dev') },
  { category: 'front', label: 'ng serve', test: (c) => c.cmd === 'ng' && c.rest[0] === 'serve' },
  { category: 'front', label: 'webpack serve', test: (c) => c.cmd === 'webpack-dev-server' || (c.cmd === 'webpack' && has(c, 'serve')) },
  { category: 'front', label: 'react-scripts start', test: (c) => c.cmd === 'react-scripts' && c.rest[0] === 'start' },
  { category: 'front', label: 'remix dev', test: (c) => c.cmd === 'remix' && c.rest[0] === 'dev' },
  { category: 'front', label: 'svelte-kit dev', test: (c) => c.cmd === 'svelte-kit' && c.rest[0] === 'dev' },
  { category: 'front', label: 'parcel', test: (c) => c.cmd === 'parcel' },
  { category: 'front', label: 'storybook', test: (c) => c.cmd === 'storybook' || c.cmd === 'start-storybook' },
  // back
  { category: 'back', label: 'nest start', test: (c) => c.cmd === 'nest' && c.rest[0] === 'start' },
  { category: 'back', label: (c) => `node ${stripExt(c.rawCmd).replace(/^.*?((dist|build)\/)/, '$1')}`, test: (c) => SERVER_ENTRY.test(c.rawCmd) && /(^|\/)(dist|build)\//.test(c.rawCmd) },
  { category: 'back', label: (c) => `${c.raw.some((a) => /(^|[/=])ts-node([/.]|$)/.test(a)) ? 'ts-node' : 'tsx'} ${stripExt(baseName(c.raw.find((a) => SERVER_ENTRY.test(a)) ?? ''))}`.trim(), test: (c) => c.raw.some((a) => /(^|[/=])(tsx|ts-node)([/.]|$)/.test(a)) && c.raw.some((a) => SERVER_ENTRY.test(a)) },
  { category: 'back', label: 'nodemon', test: (c) => c.cmd === 'nodemon' },
  { category: 'back', label: (c) => `uvicorn ${c.rest.find((a) => /^[\w.]+:\w+$/.test(a)) ?? ''}`.trim(), test: (c) => c.cmd === 'uvicorn' },
  { category: 'back', label: (c) => `gunicorn ${c.rest.find((a) => /^[\w.]+:\w+$/.test(a)) ?? ''}`.trim(), test: (c) => c.cmd === 'gunicorn' },
  { category: 'back', label: 'hypercorn', test: (c) => c.cmd === 'hypercorn' },
  { category: 'back', label: 'flask run', test: (c) => c.cmd === 'flask' && has(c, 'run') },
  { category: 'back', label: 'manage.py runserver', test: (c) => c.cmd === 'manage.py' && c.rest[0] === 'runserver' },
  { category: 'back', label: (c) => `rails ${c.rest[0]}`, test: (c) => c.cmd === 'rails' && ['s', 'server'].includes(c.rest[0]) },
  { category: 'back', label: 'puma', test: (c) => c.cmd === 'puma' },
  { category: 'back', label: 'go run', test: (c) => c.cmd === 'go' && c.rest[0] === 'run' },
  { category: 'back', label: 'air', test: (c) => c.cmd === 'air' },
  { category: 'back', label: (c) => `cargo ${c.rest[0]}`, test: (c) => c.cmd === 'cargo' && ['run', 'watch'].includes(c.rest[0]) },
  { category: 'back', label: 'java -jar', test: (c) => c.cmd === 'java' && has(c, '-jar') },
  { category: 'back', label: 'spring-boot:run', test: (c) => c.raw.some((a) => a.includes('spring-boot:run')) },
  { category: 'back', label: (c) => `dotnet ${c.rest[0]}`, test: (c) => c.cmd === 'dotnet' && ['run', 'watch'].includes(c.rest[0]) },
  { category: 'back', label: 'php artisan serve', test: (c) => c.cmd === 'php' && has(c, 'serve') && c.rest[0] === 'artisan' },
  { category: 'back', label: (c) => `deno ${c.rest[0]}`, test: (c) => c.cmd === 'deno' && ['run', 'task'].includes(c.rest[0]) },
  { category: 'back', label: (c) => `bun ${stripExt(baseName(c.rawRest.find((a) => SERVER_ENTRY.test(a) || BARE_ENTRY.test(a)) ?? ''))}`.trim(), test: (c) => c.cmd === 'bun' && c.rawRest.some((a) => SERVER_ENTRY.test(a) || BARE_ENTRY.test(a)) },
  // worker
  { category: 'worker', label: 'celery', test: (c) => c.cmd === 'celery' },
  { category: 'worker', label: 'rq worker', test: (c) => c.cmd === 'rq' && c.rest[0] === 'worker' },
  { category: 'worker', label: 'sidekiq', test: (c) => c.cmd === 'sidekiq' },
  { category: 'worker', label: (c) => c.cmd, test: (c) => is(c, 'bull', 'bullmq', 'huey_consumer', 'dramatiq') },
  { category: 'worker', label: (c) => c.cmd, test: (c) => /(^|[-_.])(worker|queue|consumer)([-_.]|$)/.test(stripExt(c.cmd)) && /\.(m?js|cjs|ts|py)$/.test(c.rawCmd) },
  // db
  { category: 'db', label: 'postgres', test: (c) => c.cmd.replace(/:$/, '') === 'postgres' || c.name === 'postgres' },
  { category: 'db', label: (c) => c.cmd, test: (c) => is(c, 'mysqld', 'mariadbd', 'redis-server', 'mongod', 'meilisearch', 'clickhouse', 'clickhouse-server', 'sqlite_web') || c.cmd === 'elasticsearch' || c.cmd === 'opensearch' },
  // container
  { category: 'container', label: (c) => c.cmd, test: (c) => /^(docker|dockerd|docker-proxy|containerd|containerd-shim(-.*)?|podman|conmon)$/.test(c.cmd) || /^containerd-shim/.test(c.name) },
  // browser
  { category: 'browser', label: 'navigateur', test: (c) => BROWSER.test(c.cmd) || BROWSER.test(c.name) || /ms-playwright\/.*(chrom|firefox)/i.test(c.rawCmd) },
];

function ctxOf(name: string, cmdline: string): Ctx {
  const raw = splitArgs(cmdline);
  const argv = raw.map(baseName);
  const p = Math.max(0, programIndex(raw.map((r) => baseName(r))));
  const rawCmd = raw[p] ?? name;
  const cmd = baseName(rawCmd).replace(/\.(m?js|cjs)$/, '');
  return { argv, raw, name, cmd: cmd || name, rawCmd, rest: argv.slice(p + 1), rawRest: raw.slice(p + 1) };
}

function matchOne(name: string, cmdline: string): CommandMatch | null {
  const ctx = ctxOf(name, cmdline);
  for (const r of COMMAND_RULES) {
    if (r.test(ctx)) {
      return { category: r.category, label: typeof r.label === 'function' ? r.label(ctx) : r.label };
    }
  }
  return null;
}

/** Premier processus de la chaîne (racine → descendants) qui correspond à une règle. */
export function matchCommand(chain: { name: string; cmdline: string }[]): CommandMatch | null {
  for (const p of chain) {
    const m = matchOne(p.name, p.cmdline);
    if (m) return m;
  }
  return null;
}

// Bureau et services seulement. Les shells et terminaux de la liste protégée (bash, zsh, warp, konsole…) ne sont pas
// « Système » : ce sont des applications de l'utilisateur, sans catégorie (ils restent protégés, avec leur cadenas).
const SYSTEM_EXACT = new Set<string>([
  'kwin_wayland', 'kwin_x11', 'plasmashell', 'gnome-shell', 'Xwayland', 'Xorg', 'sddm', 'gdm',
  'baloorunner', 'wireplumber', 'pipewire', 'pipewire-pulse', 'pulseaudio', 'polkitd', 'dbus-daemon', 'dbus-broker',
  'kded5', 'kded6', 'kglobalaccel5', 'kglobalacceld', 'ksmserver', 'kwalletd5', 'kwalletd6', 'xdg-desktop-portal',
  'upowerd', 'udisksd', 'NetworkManager', 'ibus-daemon', 'gnome-session-binary', 'gsd-', 'login', 'agetty',
]);
const SYSTEM_RE = [/^systemd/, /^at-spi/, /^xdg-/, /^kwin/, /^plasma/, /^gnome-(?!terminal)/, /^ksecretd?/, /^kscreen/, /^org\.(kde|freedesktop|gnome)\./, /^\(sd-pam\)$/, /^gsd-/, /^dbus-/];

/** Classement par nom de racine pour les groupes non-projet. */
export function classifyByName(name: string, cmdline: string): CommandMatch | null {
  const m = matchOne(name, cmdline);
  if (m) return m;
  const n = name.trim();
  const argv0 = baseName(splitArgs(cmdline)[0] ?? '');
  for (const cand of [n, argv0]) {
    if (!cand) continue;
    if (SYSTEM_EXACT.has(cand) || SYSTEM_RE.some((re) => re.test(cand))) return { category: 'system', label: cand };
    for (const s of SYSTEM_EXACT) if (s.endsWith('-') && cand.startsWith(s)) return { category: 'system', label: cand };
  }
  return null;
}
