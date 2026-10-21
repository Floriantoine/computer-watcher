// `computer-watcher should-wrap` et `computer-watcher shell-init zsh` (anti-gel : lancer directement dans le budget).
// Node pur, lecture seule : config.json (jamais créée ni réécrite ici), racine du projet, dossier courant résolu.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AntigelConfig } from '../core/antigel/config';
import { wrapCommand, type WrapCtx, type WrapShell } from '../core/antigel/wrap';
import { SHELL_INIT_USAGE, zshInit } from '../core/antigel/wrapShell';
import { configDir, validateConfig } from '../core/config';
import { findProjectRoot } from '../core/grouping/projectRoot';
import { writeOut } from './deps';

export interface WrapCliDeps {
  env: NodeJS.ProcessEnv;
  home: string;
  /** Dossier courant ; null s'il a été supprimé. */
  cwd: string | null;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  /** Texte de config.json ; null s'il est absent ou illisible. */
  readConfig: () => string | null;
  /** Chemin réel (liens résolus, comme /proc/<pid>/cwd vu par le service) ; le chemin tel quel en cas d'erreur. */
  realpath: (p: string) => string;
  findRoot: (cwd: string) => string | null;
  readStdin: () => Promise<string>;
}

export const SHOULD_WRAP_USAGE = `Usage : computer-watcher should-wrap [--shell sh|bash|zsh] [--cwd <dossier>] -- <ligne de commande>

Code 0 et la ligne réécrite (computer-watcher run -- …) sur la sortie standard si la ligne lance un travail lourd
(jest, vitest, tsc, npm test…) dans un projet qui a un budget anti-gel ; code 1 sans rien écrire sinon.
--shell : shell des lignes composées (<shell> -c '…'), sh par défaut. --cwd : dossier de la ligne (défaut : courant).
`;

const CONFIG_MAX_BYTES = 4 * 1024 * 1024;

/** Section antigel d'un config.json, comme le service la lirait ; null si absent, illisible ou refusé. */
export function antigelFromConfigText(text: string | null): AntigelConfig | null {
  if (text === null) return null;
  try {
    return validateConfig(JSON.parse(text))?.antigel ?? null;
  } catch {
    return null;
  }
}

export function wrapCtx(d: WrapCliDeps): WrapCtx {
  return { home: d.home, env: d.env, config: antigelFromConfigText(d.readConfig()), findRoot: d.findRoot };
}

const SHELLS: readonly WrapShell[] = ['sh', 'bash', 'zsh'];

/** Ligne réécrite pour `cwd` (résolu), null sinon ; jamais d'exception. */
export function rewrite(d: WrapCliDeps, line: string, cwd: string | null, shell: WrapShell): string | null {
  try {
    if (cwd === null) return null;
    return wrapCommand(line, d.realpath(cwd), wrapCtx(d), { shell });
  } catch {
    return null;
  }
}

export function shouldWrapCli(args: readonly string[], d: WrapCliDeps): number {
  const usage = (m: string) => {
    d.stderr(`computer-watcher should-wrap : ${m}\n${SHOULD_WRAP_USAGE}`);
    return 2;
  };
  let shell: WrapShell = 'sh';
  let cwd = d.cwd;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') break;
    if (a === '-h' || a === '--help') {
      d.stdout(SHOULD_WRAP_USAGE);
      return 0;
    }
    if (a === '--shell' || a === '--cwd') {
      const v = args[++i];
      if (v === undefined) return usage(`${a} : valeur manquante`);
      if (a === '--cwd') cwd = v;
      else if ((SHELLS as readonly string[]).includes(v)) shell = v as WrapShell;
      else return usage(`--shell : sh, bash ou zsh (reçu ${v})`);
      continue;
    }
    return usage(`option inconnue : ${a}`);
  }
  if (args[i] !== '--' || i + 1 >= args.length) return usage('« -- » et la ligne manquent');
  const out = rewrite(d, args.slice(i + 1).join(' '), cwd, shell);
  if (out === null) return 1;
  d.stdout(`${out}\n`);
  return 0;
}

export function shellInitCli(args: readonly string[], d: WrapCliDeps): number {
  if (args.length === 1 && args[0] === 'zsh') {
    d.stdout(zshInit());
    return 0;
  }
  if (args.length === 1 && (args[0] === '-h' || args[0] === '--help')) {
    d.stdout(SHELL_INIT_USAGE);
    return 0;
  }
  d.stderr(`computer-watcher shell-init : seul zsh est pris en charge\n${SHELL_INIT_USAGE}`);
  return 2;
}

function readConfigText(env: NodeJS.ProcessEnv, home: string): string | null {
  try {
    const file = join(configDir(env, home), 'config.json');
    if (statSync(file).size > CONFIG_MAX_BYTES) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const STDIN_MAX_BYTES = 4 * 1024 * 1024;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of process.stdin) {
    const b = typeof c === 'string' ? Buffer.from(c) : (c as Buffer);
    n += b.length;
    if (n > STDIN_MAX_BYTES) throw new Error('entrée trop grande');
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function realWrapDeps(): WrapCliDeps {
  const env = process.env;
  const home = homedir();
  let cwd: string | null;
  try {
    cwd = process.cwd();
  } catch {
    cwd = null;
  }
  return {
    env,
    home,
    cwd,
    stdout: (s) => writeOut(1, s),
    stderr: (s) => writeOut(2, s),
    readConfig: () => readConfigText(env, home),
    realpath: (p) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    },
    findRoot: (c) => findProjectRoot(c, existsSync, home),
    readStdin,
  };
}
