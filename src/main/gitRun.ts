// git pour la page Disque : binaire système par chemin absolu, argv sans shell, environnement nettoyé (aucune variable
// GIT_* héritée), fsmonitor et hooks désactivés, jamais d'invite, aucun verrou optionnel.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cleanEnv, systemBin } from '../core/childEnv';

export type GitRun = (args: string[], o: { cwd: string; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Options passées avant toute commande : rien du dépôt n'est exécuté (fsmonitor, hooks). */
export const GIT_SAFE_ARGS: readonly string[] = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'color.ui=false', '-c', 'core.quotePath=false'];

export function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(cleanEnv(env))) if (!k.startsWith('GIT_') && v !== undefined) out[k] = v;
  return { ...out, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
}

/** Dernière ligne non vide, sans caractère de contrôle, 200 caractères au plus (messages de refus affichés). */
export function lastLine(s: string): string {
  const l = s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').split('\n').map((x) => x.trim()).filter(Boolean).at(-1) ?? '';
  return l.length > 200 ? `${l.slice(0, 200)}…` : l;
}

/** Lanceur de git ; null si /usr/bin/git et /bin/git sont absents. */
export function createGitRun(o: { exists?: (p: string) => boolean; env?: NodeJS.ProcessEnv } = {}): GitRun | null {
  const bin = systemBin('git', o.exists ?? existsSync);
  if (!bin) return null;
  const env = gitEnv(o.env ?? process.env);
  return (args, { cwd, timeoutMs = 60_000 }) =>
    new Promise((resolve, reject) => {
      execFile(bin, [...GIT_SAFE_ARGS, ...args], { cwd, env, timeout: timeoutMs, maxBuffer: 8 << 20, encoding: 'utf8' }, (err, stdout, stderr) => {
        const out = String(stdout ?? '');
        const errText = String(stderr ?? '');
        if (!err) return resolve({ code: 0, stdout: out, stderr: errText });
        if ((err as { killed?: boolean }).killed) return resolve({ code: 124, stdout: out, stderr: 'délai dépassé' });
        const code = (err as NodeJS.ErrnoException).code as unknown;
        if (typeof code === 'number') return resolve({ code, stdout: out, stderr: errText });
        reject(err);
      });
    });
}

/**
 * Clés de config qui font exécuter du code par `git status` ou `git worktree remove` (filtres clean/smudge/process activés
 * par `.gitattributes`) ou qui le feraient sans nos `-c` (fsmonitor, hooks).
 */
export const RISKY_GIT_CONFIG_RE = '^(filter\\..*\\.(clean|smudge|process)|core\\.(fsmonitor|hookspath))$';
/** Portées jamais retenues : nos propres `-c` (command) et la config de l'utilisateur ou du système (git-lfs, etc.). */
const TRUSTED_SCOPES: ReadonlySet<string> = new Set(['command', 'global', 'system']);
export const RISKY_GIT_CONFIG_REFUSAL = 'filtre git configuré : vérifie à la main';

/**
 * Lecture seule de la config vue depuis `cwd` (dépôt, includes et config de worktree si `extensions.worktreeConfig`
 * compris) : jamais de filtre exécuté. null si rien de risqué dans la config du dépôt ou du worktree, sinon la raison.
 * Toute ligne illisible, ou de portée inconnue, compte comme risquée.
 */
export async function riskyGitConfig(git: GitRun, cwd: string): Promise<string | null> {
  const r = await git(['config', '--includes', '--show-scope', '--name-only', '--get-regexp', RISKY_GIT_CONFIG_RE], { cwd });
  if (r.code === 1 && !r.stdout.trim()) return null; // aucune entrée
  if (r.code !== 0) return `config git illisible : ${lastLine(r.stderr)}`;
  const risky = r.stdout.split('\n').filter(Boolean).some((l) => {
    const tab = l.indexOf('\t');
    return tab < 0 || !TRUSTED_SCOPES.has(l.slice(0, tab));
  });
  return risky ? RISKY_GIT_CONFIG_REFUSAL : null;
}
