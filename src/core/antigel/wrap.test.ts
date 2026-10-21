import { describe, expect, test } from 'vitest';
import type { AntigelConfig } from './config';
import { HEAVY_NAMES, lexLine, planWrap, shellQuote, shouldWrap, wrapCommand, type WrapCtx } from './wrap';

const HOME = '/home/u';
const DEMO = '/home/u/code/demo';
const cfg = (o: Partial<AntigelConfig> = {}): AntigelConfig => ({ enabled: true, reserveMB: null, budgets: { [DEMO]: 6144 }, ...o });
const ctx = (o: Partial<WrapCtx> = {}): WrapCtx => ({
  home: HOME,
  env: {},
  config: cfg(),
  // racine : le dossier « demo » ou « projet-a » au-dessus du dossier courant
  findRoot: (cwd) => {
    const m = /^(\/home\/u\/code\/(demo|projet-a))(\/|$)/.exec(cwd);
    return m ? m[1]! : null;
  },
  ...o,
});
const IN = `${DEMO}/src`;

describe('shouldWrap : commande lourde dans un projet qui a un budget', () => {
  test.each([
    'jest', 'npx jest --watchAll=false', 'vitest run', 'tsc --noEmit', 'eslint .', 'npm test', 'npm t', 'npm run build', 'npm exec vitest',
    'pnpm test', 'pnpm run lint', 'yarn test', 'yarn run build', 'bun test', 'bun run dev', 'npx playwright test', 'pnpx tsc', 'bunx vitest',
    'make', 'make -j8 all', 'cargo build --release', 'cargo test', 'cargo +nightly test', 'gradle build', './gradlew test', 'mvn package',
    './mvnw verify', 'pytest -x', 'python -m pytest', 'python3 -m pytest tests', 'playwright test', 'go test ./...',
    './node_modules/.bin/jest', 'node_modules/.bin/vitest run', '/usr/bin/make', 'npm --silent test', 'jest # commentaire',
  ])('%s → vrai', (cmd) => {
    expect(shouldWrap(cmd, IN, ctx())).toBe(true);
  });

  test.each([
    'ls -la', 'git status', 'npm install', 'npm i', 'yarn add left-pad', 'cargo fmt', 'go fmt ./...', 'python script.py', 'node index.js',
    'echo jest', 'cat jest.config.js', 'grep -r vitest .', 'npm', 'cargo', 'python -m http.server', '', '   ', '# jest',
  ])('%s → faux', (cmd) => {
    expect(shouldWrap(cmd, IN, ctx())).toBe(false);
  });

  test('hors projet, projet sans budget, dossier personnel : faux', () => {
    expect(shouldWrap('jest', '/home/u/code/projet-a', ctx())).toBe(false);
    expect(shouldWrap('jest', '/tmp/x', ctx())).toBe(false);
    expect(shouldWrap('jest', HOME, ctx({ findRoot: () => HOME }))).toBe(false);
    expect(shouldWrap('jest', '/', ctx({ findRoot: () => '/' }))).toBe(false);
  });

  test('anti-gel éteint, config illisible, interrupteurs d’environnement : faux', () => {
    expect(shouldWrap('jest', IN, ctx({ config: cfg({ enabled: false }) }))).toBe(false);
    expect(shouldWrap('jest', IN, ctx({ config: null }))).toBe(false);
    expect(shouldWrap('jest', IN, ctx({ env: { CWATCH_NO_WRAP: '1' } }))).toBe(false);
    expect(shouldWrap('jest', IN, ctx({ env: { PROC_WATCH_NO_ANTIGEL: '1' } }))).toBe(false);
    expect(shouldWrap('jest', IN, ctx({ env: { CWATCH_NO_WRAP: '0' } }))).toBe(true);
  });

  test('racine du budget normalisée (barre finale) ; racine du projet comparée exactement', () => {
    expect(shouldWrap('jest', IN, ctx({ config: cfg({ budgets: { [`${DEMO}`]: 1024 } }) }))).toBe(true);
    expect(shouldWrap('jest', IN, ctx({ config: cfg({ budgets: { '/home/u/code': 1024 } }) }))).toBe(false);
    expect(shouldWrap('jest', IN, ctx({ findRoot: () => `${DEMO}/` }))).toBe(true);
  });

  test('budget par défaut : un projet sans budget explicite est enveloppé ; « sans budget » ou défaut retiré : non', () => {
    expect(shouldWrap('jest', IN, ctx({ config: cfg({ budgets: {}, defaultBudgetMB: 5120 }) }))).toBe(true);
    expect(shouldWrap('jest', IN, ctx({ config: cfg({ budgets: {}, defaultBudgetMB: null }) }))).toBe(false);
    expect(shouldWrap('jest', IN, ctx({ config: cfg({ budgets: {}, defaultBudgetMB: 5120, noBudget: [DEMO] }) }))).toBe(false);
    // hors projet : jamais, même avec un défaut
    expect(shouldWrap('jest', IN, ctx({ config: cfg({ budgets: {}, defaultBudgetMB: 5120 }), findRoot: () => null }))).toBe(false);
  });

  test('cwd vide ou relatif : faux', () => {
    expect(shouldWrap('jest', '', ctx())).toBe(false);
    expect(shouldWrap('jest', 'demo', ctx())).toBe(false);
  });
});

describe('shouldWrap : déjà enveloppée, interactive, changement d’état du shell → faux', () => {
  test.each([
    'computer-watcher run -- jest', 'computer-watcher run --mem 6G -- npm test', '/usr/bin/computer-watcher run -- jest',
    'systemd-run --user --scope jest', 'sudo make install', 'doas make', 'pkexec make', 'run0 make',
    'cd front && npm test', 'npm test && cd ..', 'export CI=1; npm test', 'source .env && npm test', '. ./env.sh; jest', 'pushd x; make; popd',
    'CI=1; npm test', 'eval "npm test"', 'exec npm test', 'alias t=jest; t', 'set -e; make', 'ulimit -v 100; make', 'umask 077 && make',
    'vim jest.config.js', 'nvim . && jest', 'jest | less', 'ssh hôte make', 'tmux new jest', 'watch -n1 make', 'htop',
    'time npm test', 'env CI=1 npm test', 'nice make', 'nohup make', 'timeout 60 jest', 'command make', 'noglob npx jest src/*',
    'f() { jest; }; f', 'function f { jest }', 'case x in a) jest;; esac', 'coproc make',
    'cat <<EOF\nx\nEOF\njest', 'jest &\nmake', 'jest & make', 'make |& tee log', 'jest; !!', 'npm test "$(cat <<EOF',
    'echo "non fermé; jest', "jest 'non fermé", 'jest \\', 'make $(echo', '( jest', 'jest )',
  ])('%s → faux', (cmd) => {
    expect(shouldWrap(cmd, IN, ctx())).toBe(false);
  });
});

describe('wrapCommand : réécriture', () => {
  const w = (cmd: string, shell?: 'sh' | 'bash' | 'zsh') => wrapCommand(cmd, IN, ctx(), shell === undefined ? {} : { shell });

  test('commande simple : préfixe, le reste analysé par le shell appelant comme avant', () => {
    expect(w('npm test')).toBe('computer-watcher run -- npm test');
    expect(w('jest src/*.test.ts --ci $ARGS "a b" \'c d\'')).toBe('computer-watcher run -- jest src/*.test.ts --ci $ARGS "a b" \'c d\'');
    expect(w('npx jest > out.log 2>&1')).toBe('computer-watcher run -- npx jest > out.log 2>&1');
    expect(w('  make -j8  ')).toBe('  computer-watcher run -- make -j8  ');
  });

  test('affectations en tête : restent devant (transmises par run à la commande)', () => {
    expect(w('CI=1 NODE_OPTIONS="--max-old-space-size=4096" npm test')).toBe('CI=1 NODE_OPTIONS="--max-old-space-size=4096" computer-watcher run -- npm test');
  });

  test('arrière-plan final : le préfixe garde le & au shell appelant', () => {
    expect(w('npm run dev &')).toBe('computer-watcher run -- npm run dev &');
    expect(w('jest;')).toBe('computer-watcher run -- jest;');
  });

  test('commande composée : toute la ligne dans <shell> -c, entre apostrophes', () => {
    expect(w('npm run build && npm test')).toBe("computer-watcher run -- sh -c 'npm run build && npm test'");
    expect(w('echo début; jest | tee log', 'zsh')).toBe("computer-watcher run -- zsh -c 'echo début; jest | tee log'");
    expect(w('(make) || echo raté', 'bash')).toBe("computer-watcher run -- bash -c '(make) || echo raté'");
    expect(w('git pull && make')).toBe("computer-watcher run -- sh -c 'git pull && make'");
    expect(w('if make; then echo ok; fi')).toBe("computer-watcher run -- sh -c 'if make; then echo ok; fi'");
    expect(w('for d in a b; do jest $d; done')).toBe("computer-watcher run -- sh -c 'for d in a b; do jest $d; done'");
    expect(w('{ make; }')).toBe("computer-watcher run -- sh -c '{ make; }'");
  });

  test('quoting : apostrophes, $, guillemets, retours à la ligne, antislash', () => {
    expect(w("echo 'l'\"'\"'arbre' && jest")).toBe(`computer-watcher run -- sh -c 'echo '\\''l'\\''"'\\''"'\\''arbre'\\'' && jest'`);
    expect(w('echo "$HOME `id`" && jest')).toBe("computer-watcher run -- sh -c 'echo \"$HOME `id`\" && jest'");
    expect(w('make\njest\n')).toBe("computer-watcher run -- sh -c 'make\njest'");
    expect(w('echo a\\;b && make')).toBe("computer-watcher run -- sh -c 'echo a\\;b && make'");
    expect(w("echo $'x\\'y' && make", 'bash')).toBe(`computer-watcher run -- bash -c 'echo $'\\''x\\'\\''y'\\'' && make'`);
  });

  test('pas lourd ou refusé : null', () => {
    expect(w('ls')).toBeNull();
    expect(w('cd x && jest')).toBeNull();
  });

  test('binaire du lanceur personnalisable', () => {
    expect(wrapCommand('jest', IN, ctx(), { bin: '/opt/cw/computer-watcher' })).toBe('/opt/cw/computer-watcher run -- jest');
  });
});

describe('analyse lexicale', () => {
  test('mot entre guillemets ou avec substitution : jamais pris pour un opérateur', () => {
    expect(planWrap('echo "a && b" && make', IN, ctx())?.kind).toBe('shell');
    expect(planWrap('echo "a && b"; ls', IN, ctx())).toBeNull();
    expect(planWrap('echo $(make) ; ls', IN, ctx())).toBeNull(); // substitution non inspectée
    expect(planWrap('echo `make`', IN, ctx())).toBeNull();
    expect(planWrap('"jest"', IN, ctx())?.kind).toBe('prefix');
    expect(planWrap('j"es"t', IN, ctx())?.kind).toBe('prefix');
    expect(planWrap('$JEST', IN, ctx())).toBeNull();
    expect(planWrap('echo ${x:-a;b} && make', IN, ctx())?.kind).toBe('shell');
  });

  test('ligne incomplète : null', () => {
    for (const s of ['"', "'", '$(', '`', '${', 'a \\', '$((1+']) expect(lexLine(s), s).toBeNull();
  });

  test('shellQuote', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    expect(shellQuote('')).toBe("''");
  });

  test('noms lourds : liste non vide, sans caractère spécial (motif zsh)', () => {
    expect(HEAVY_NAMES.length).toBeGreaterThan(20);
    for (const n of HEAVY_NAMES) expect(n).toMatch(/^[a-z0-9._+-]+$/);
  });
});

describe('lignes incomplètes (le shell demanderait la suite) : null', () => {
  test.each(['make &&', '&& make', 'make |', 'if make; then', 'for f in a; do jest', '{ make', 'make; fi'])('%s', (cmd) => {
    expect(planWrap(cmd, IN, ctx())).toBeNull();
  });
});

describe('équivalence réelle : la ligne réécrite produit la même sortie (sh, bash, zsh présents)', async () => {
  const { execFileSync } = await import('node:child_process');
  const { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const lines = [
    `jest 'a b' "c\\"d" $X`,
    `X='un$deux' jest "$X" '$X'`,
    `echo "l'arbre" && jest "$(echo sub)" \`echo bq\`; echo fin`,
    `jest 'a\nb' | tr a-z A-Z`,
    `jest a\\;b && jest "\\$HOME"`,
    `(jest p) || echo jamais\njest q`,
    `jest '"'"'"'"'`,
  ];
  for (const sh of ['sh', 'bash', 'zsh'] as const) {
    test.skipIf(!['/bin/', '/usr/bin/'].some((d) => existsSync(d + sh)))(sh, () => {
      mkdirSync(join(homedir(), '.cache'), { recursive: true });
      const dir = mkdtempSync(join(homedir(), '.cache', 'pw-wrap-'));
      try {
        // faux jest (imprime ses arguments) et faux lanceur (saute « run -- », exécute le reste)
        writeFileSync(join(dir, 'jest'), '#!/bin/sh\nfor a in "$@"; do printf "[%s]" "$a"; done; echo\n');
        writeFileSync(join(dir, 'cw'), '#!/bin/sh\n[ "$1" = run ] && [ "$2" = -- ] || exit 99\nshift 2\nexec "$@"\n');
        chmodSync(join(dir, 'jest'), 0o755);
        chmodSync(join(dir, 'cw'), 0o755);
        const env = { PATH: `${dir}:/usr/bin:/bin`, X: 'x y', HOME: dir };
        for (const line of lines) {
          const out = wrapCommand(line, IN, ctx(), { shell: sh, bin: join(dir, 'cw') });
          expect(out, line).not.toBeNull();
          const run = (l: string) => execFileSync(sh, ['-c', l], { env, encoding: 'utf8', cwd: dir });
          expect(run(out!), `${sh} : ${out}`).toBe(run(line));
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
