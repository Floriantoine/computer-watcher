import { describe, expect, test } from 'vitest';
import { classifyByName, matchCommand } from './rules';

const P = '/home/u/acme/node_modules/.bin';
type C = { name: string; cmdline: string };
const n = (cmdline: string, name = 'node'): C => ({ name, cmdline });

describe('matchCommand', () => {
  test.each([
    [[n(`node ${P}/vite`)], 'front', 'vite'],
    [[n(`node ${P}/vite --port 5174`)], 'front', 'vite'],
    [[n(`node ${P}/vite build`)], 'build', 'vite build'],
    [[n(`node ${P}/vite preview`)], 'front', 'vite preview'],
    [[n(`node ${P}/vitest run`)], 'test', 'vitest'],
    [[n('npm run dev', 'npm'), n('node /home/u/acme/node_modules/.bin/next dev')], 'front', 'next dev'],
    [[n(`node ${P}/nest start --watch`)], 'back', 'nest start'],
    [[n('node dist/main')], 'back', 'node dist/main'],
    [[n('node /home/u/acme/dist/main.js')], 'back', 'node dist/main'],
    [[n(`node ${P}/tsx watch src/server.ts`)], 'back', 'tsx server'],
    [[n('python -m uvicorn app.main:app --reload', 'python')], 'back', 'uvicorn app.main:app'],
    [[n('python manage.py runserver 0.0.0.0:8000', 'python')], 'back', 'manage.py runserver'],
    [[n('celery -A proj worker -l info', 'celery')], 'worker', 'celery'],
    [[n('postgres: checkpointer', 'postgres')], 'db', 'postgres'],
    [[n('/usr/bin/postgres -D /var/lib/postgres/data', 'postgres')], 'db', 'postgres'],
    [[n('redis-server *:6379', 'redis-server')], 'db', 'redis-server'],
    [[n('node /home/u/acme/node_modules/playwright/cli.js test')], 'test', 'playwright test'],
    [[n('node /home/u/my-mcp/node_modules/.bin/vite')], 'front', 'vite'],
    [[n('node /home/u/my-mcp/node_modules/vite/bin/vite.js')], 'front', 'vite'],
    [[n('node /home/u/acme/node_modules/vitest/vitest.mjs run')], 'test', 'vitest'],
    [[n(`node ${P}/mcp-server-fs /tmp`)], 'ai', 'mcp-server-fs'],
    [[n(`node ${P}/vite --mode production build`)], 'build', 'vite build'],
    [[n(`node ${P}/vite optimize`)], 'build', 'vite build'],
    [[n(`node ${P}/vite preview --outDir build`)], 'front', 'vite preview'],
    [[n(`node ${P}/vite --outDir build`)], 'front', 'vite'],
    [[n(`node ${P}/vite --base /build/`)], 'front', 'vite'],
    [[n(`node ${P}/vite --config build/vite.config.ts`)], 'front', 'vite'],
    [[n('node --require /home/u/acme/node_modules/tsx/dist/preflight.cjs --import file:///home/u/acme/node_modules/tsx/dist/loader.mjs src/server.ts')], 'back', 'tsx server'],
    [[n('bun run src/index.ts', 'bun')], 'back', 'bun index'],
    [[n('bun --watch server.ts', 'bun')], 'back', 'bun server'],
    [[n('deno task dev', 'deno')], 'back', 'deno task'],
    [[n('php artisan serve --port=8000', 'php')], 'back', 'php artisan serve'],
    [[n('gopls serve', 'gopls')], 'build', 'gopls'],
    [[n('turbo daemon', 'turbo')], 'build', 'turbo daemon'],
    [[n('go build ./...', 'go')], null, null],
    [[n('rails console', 'ruby')], null, null],
    [[n('turbo run dev', 'turbo')], null, null],
    [[n('air', 'air')], 'back', 'air'],
    [[n('/usr/bin/air-quality-app', 'air-quality-app')], null, null],
    [[n(`node ${P}/playwright test`)], 'test', 'playwright test'],
    [[n(`node ${P}/tsc --watch`)], 'build', 'tsc --watch'],
    [[n('node /home/u/acme/node_modules/typescript/lib/tsserver.js')], 'build', 'tsserver'],
    [[n('containerd-shim-runc-v2 -namespace moby', 'containerd-shim')], 'container', 'containerd-shim-runc-v2'],
    [[n('/opt/google/chrome/chrome --type=renderer', 'chrome')], 'browser', 'navigateur'],
    [[n('claude --resume x', 'claude')], 'ai', 'claude'],
    [[n('node /home/u/.npm/_npx/x/node_modules/@playwright/mcp/cli.js')], 'ai', '@playwright/mcp'],
    [[n('node /home/u/.npm/_npx/x/node_modules/.bin/context7-mcp')], 'ai', 'context7-mcp'],
    [[n('node /home/u/script.js')], null, null],
  ] as [C[], string | null, string | null][])('%j', (chain, cat, label) => {
    const m = matchCommand(chain);
    if (cat === null) expect(m).toBeNull();
    else expect(m).toEqual({ category: cat, label });
  });

  test('parcourt la chaîne de la racine vers les descendants', () => {
    expect(matchCommand([n('npm run dev', 'npm'), n(`node ${P}/vite`), n('esbuild --service', 'esbuild')])?.label).toBe('vite');
  });
  test('vitest n est pas vite', () => {
    expect(matchCommand([n(`node ${P}/vitest`)])?.category).toBe('test');
  });
});

describe('classifyByName', () => {
  test.each([
    ['chrome', '/opt/google/chrome/chrome --type=zygote', 'browser'],
    ['claude', 'claude', 'ai'],
    ['postgres', 'postgres: writer', 'db'],
    ['dockerd', '/usr/bin/dockerd -H fd://', 'container'],
    ['kwin_wayland', '/usr/bin/kwin_wayland', 'system'],
    ['systemd', '/usr/lib/systemd/systemd --user', 'system'],
    ['pipewire', '/usr/bin/pipewire', 'system'],
    ['plasmashell', '/usr/bin/plasmashell', 'system'],
    ['Xwayland', '/usr/bin/Xwayland :0', 'system'],
    ['xdg-desktop-por', '/usr/lib/xdg-desktop-portal-kde', 'system'],
    ['sddm', '/usr/bin/sddm', 'system'],
  ])('%s', (name, cmd, cat) => {
    expect(classifyByName(name, cmd)?.category).toBe(cat);
  });
  test('inconnu', () => expect(classifyByName('foobar', '/opt/foobar')).toBeNull());
  // Shells et terminaux : applications de l'utilisateur, pas « Système » (ils restent protégés, sans catégorie).
  test.each([['bash', '-bash'], ['zsh', '/usr/bin/zsh'], ['sh', 'sh'], ['fish', 'fish'], ['warp', '/opt/warpdotdev/warp-terminal/warp'],
    ['konsole', '/usr/bin/konsole'], ['gnome-terminal-', 'gnome-terminal-server'], ['kitty', 'kitty'], ['tmux: server', 'tmux'], ['ghostty', 'ghostty']])(
    'shell/terminal %s -> aucune catégorie', (name, cmd) => expect(classifyByName(name, cmd)).toBeNull(),
  );
});
