// Le snippet de `computer-watcher shell-init zsh` dans un vrai zsh interactif (pseudo-terminal de script(1)), avec un
// faux computer-watcher et un faux jest dans un HOME temporaire sous ~/.cache/pw-* : réécriture, historique d'origine,
// interrupteur CWATCH_NO_WRAP, échec de l'outil.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { zshInit } from '../core/antigel/wrapShell';

const has = (b: string) => ['/usr/bin/', '/bin/'].some((d) => existsSync(d + b));

test.skipIf(!has('zsh') || !has('script'))('widget zsh : ligne réécrite, historique lisible, désactivable, jamais cassée', () => {
  mkdirSync(join(homedir(), '.cache'), { recursive: true });
  const dir = mkdtempSync(join(homedir(), '.cache', 'pw-wrap-zsh-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(dir, 'init.zsh'), zshInit());
    // faux computer-watcher : should-wrap réécrit « jest a » et « jest 'x y' && jest z », échoue sur « jest boum » ;
    // run imprime un repère puis exécute la commande
    writeFileSync(join(bin, 'computer-watcher'), `#!/bin/sh
case "$1" in
  should-wrap)
    [ "$2 $3 $4" = "--shell zsh --" ] || exit 9
    case "$5" in
      "jest a") printf '%s\\n' "computer-watcher run -- jest a" ;;
      "jest 'x y' && jest z") printf '%s\\n' "computer-watcher run -- zsh -c 'jest '\\\\''x y'\\\\'' && jest z'" ;;
      "jest boum") echo "computer-watcher run -- false"; exit 3 ;;
      *) exit 1 ;;
    esac ;;
  run) shift 2; echo "ENVELOPPE"; exec "$@" ;;
  *) exit 2 ;;
esac
`);
    writeFileSync(join(bin, 'jest'), '#!/bin/sh\necho "JEST[$*]"\n');
    chmodSync(join(bin, 'computer-watcher'), 0o755);
    chmodSync(join(bin, 'jest'), 0o755);
    writeFileSync(join(dir, '.zshrc'), `PROMPT='%% '
HISTFILE=${dir}/hist
HISTSIZE=100
SAVEHIST=100
setopt INC_APPEND_HISTORY
source ${dir}/init.zsh
`);
    const input = [
      'jest a',
      "jest 'x y' && jest z",
      'jest boum',
      'export CWATCH_NO_WRAP=1',
      'jest a',
      'unset CWATCH_NO_WRAP',
      'echo FIN',
      'exit',
      '',
    ].join('\n');
    const out = execFileSync('script', ['-qec', 'zsh -i', '/dev/null'], {
      input, encoding: 'utf8', timeout: 20_000,
      env: { HOME: dir, ZDOTDIR: dir, PATH: `${bin}:/usr/bin:/bin`, TERM: 'dumb' },
    });
    const lines = out.replace(/\r/g, '').split('\n').filter((l) => /ENVELOPPE|JEST\[|FIN$/.test(l) && !l.includes('echo'));
    expect(lines.map((l) => l.replace(/^.*?(ENVELOPPE|JEST\[)/, '$1'))).toEqual([
      'ENVELOPPE', 'JEST[a]', 'ENVELOPPE', 'JEST[x y]', 'JEST[z]', 'JEST[boum]', 'JEST[a]', 'FIN',
    ]);
    const hist = readFileSync(join(dir, 'hist'), 'utf8');
    expect(hist).not.toContain('computer-watcher');
    expect(hist.split('\n').filter(Boolean)).toEqual([
      'jest a', "jest 'x y' && jest z", 'jest boum', 'export CWATCH_NO_WRAP=1', 'jest a', 'unset CWATCH_NO_WRAP', 'echo FIN', 'exit',
    ]);
    // le snippet est idempotent (chargé deux fois : un seul widget)
    expect(execFileSync('zsh', ['-n', join(dir, 'init.zsh')], { encoding: 'utf8' })).toBe('');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
