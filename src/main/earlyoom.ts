// État d'earlyoom et application d'une nouvelle configuration via pkexec d'un script fixe.
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEarlyoomArgs, EARLYOOM_LINE_PATTERN, EARLYOOM_LINE_RE, EARLYOOM_MAX_FILE_BYTES, isEarlyoomSettings, parseEarlyoomDefault } from '../core/earlyoom';
import type { ApplyResult, EarlyoomStatus } from '../core/types';

export type ExecFn = (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

export const EARLYOOM_TARGET = '/etc/default/earlyoom';
export const EARLYOOM_SYSTEMCTL = '/usr/bin/systemctl';
export const PKEXEC = '/usr/bin/pkexec';
export const EARLYOOM_INSTALL_HINT = 'sudo pacman -S earlyoom && sudo systemctl enable --now earlyoom';
const APPLY_TIMEOUT_MS = 120_000; // saisie du mot de passe

/** execFile qui résout avec le code de sortie ; rejette seulement si la commande est introuvable (ENOENT). */
export const defaultRun: ExecFn = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts?.timeout ?? 10_000, maxBuffer: 1 << 20, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(err);
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

const readText = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

export async function earlyoomStatus(deps: {
  run?: ExecFn;
  exists?: (p: string) => boolean;
  read?: (p: string) => string | null;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<EarlyoomStatus> {
  const run = deps.run ?? defaultRun;
  const exists = deps.exists ?? existsSync;
  const read = deps.read ?? readText;
  const env = deps.env ?? process.env;
  const bin = env.PROC_WATCH_EARLYOOM_BIN || '/usr/bin/earlyoom';
  const installed = exists(bin);
  let version: string | null = null;
  let active: EarlyoomStatus['active'] = 'unknown';
  if (installed) {
    const [v, a] = await Promise.all([
      run(bin, ['-v'], { timeout: 5000 }).catch(() => null),
      run('systemctl', ['is-active', 'earlyoom'], { timeout: 5000 }).catch(() => null),
    ]);
    version = v?.stdout.match(/earlyoom\s+v?(\d[\w.+-]*)/)?.[1] ?? null;
    const s = a?.stdout.trim();
    if (s === 'active' || s === 'inactive' || s === 'failed') active = s;
  }
  const text = read(EARLYOOM_TARGET);
  return { installed, version, active, file: text === null ? null : parseEarlyoomDefault(text), installHint: EARLYOOM_INSTALL_HINT };
}


// Le motif bash vient de la même constante que EARLYOOM_LINE_RE (liste blanche EARLYOOM_REGEX_CHARS).
if (EARLYOOM_LINE_PATTERN.includes("'")) throw new Error('motif earlyoom : apostrophe interdite');

/**
 * Script fixe exécuté en root par pkexec (`bash -c`, pas de fichier .sh : dans une AppImage les fichiers de
 * l'app vivent sous un montage FUSE illisible par root). Il n'est construit qu'à partir de constantes du module
 * (jamais d'une entrée) et ne lit AUCUNE variable d'environnement : cible, systemctl, PATH et locale sont fixés.
 *
 * Le fichier source est un 0600 dans un dossier mkdtemp 0700 de l'utilisateur. L'utilisateur peut le remplacer
 * entre les vérifications et la lecture (lien, autre fichier) : c'est sans conséquence, car le contenu est lu
 * UNE fois dans une variable puis validé par le motif sur cette variable ; seul un contenu conforme est écrit.
 * Un FIFO est refusé (-p) pour que la lecture ne puisse pas bloquer ; un FIFO substitué après coup ne peut que
 * bloquer ce bash (aucun effet sur /etc), et l'app abandonne après 120 s.
 *
 * Valide la ligne, copie l'ancien fichier en .bak-<date>, écrit le nouveau et redémarre earlyoom ; restaure
 * l'ancien si le redémarrage échoue. Codes : 10 fichier refusé, 11 ligne non conforme, 12 écriture impossible,
 * 13 redémarrage en échec (ancien fichier restauré).
 */
export const EARLYOOM_APPLY_SCRIPT = `set -u
export PATH=/usr/bin:/bin LC_ALL=C
src="\${1:-}"
target=${EARLYOOM_TARGET}
systemctl=${EARLYOOM_SYSTEMCTL}
re='${EARLYOOM_LINE_PATTERN}'
[[ -n "$src" && -f "$src" && ! -L "$src" && ! -p "$src" ]] || exit 10
[[ $(stat -c %s -- "$src") -le ${EARLYOOM_MAX_FILE_BYTES} ]] || exit 10
[[ $(grep -c '' "$src") -eq 1 ]] || exit 10
line=""
IFS= read -r line < "$src" || true
[[ "$line" =~ $re ]] || exit 11
bak=""
if [[ -e "$target" ]]; then bak="$target.bak-$(date +%Y%m%dT%H%M%S)"; cp -p -- "$target" "$bak" || exit 12; fi
{ printf '%s\\n' "$line" > "$target.proc-watch.tmp" && chmod 644 "$target.proc-watch.tmp" && mv -f -- "$target.proc-watch.tmp" "$target"; } || { rm -f -- "$target.proc-watch.tmp"; exit 12; }
if ! "$systemctl" restart earlyoom; then
  if [[ -n "$bak" ]]; then cp -p -- "$bak" "$target"; else rm -f -- "$target"; fi
  "$systemctl" restart earlyoom
  exit 13
fi
exit 0
`;

export function applyExitMessage(code: number, line: string): ApplyResult {
  switch (code) {
    case 0: return { ok: true, line };
    case 126: return { ok: false, reason: 'cancelled', message: "Authentification annulée : rien n'a été modifié." };
    case 127: return { ok: false, reason: 'unavailable', message: "pkexec indisponible ou aucun agent d'authentification : rien n'a été modifié." };
    case 10:
    case 11: return { ok: false, reason: 'invalid', message: "Ligne refusée par le script de vérification : rien n'a été modifié." };
    case 12: return { ok: false, reason: 'failed', message: "Écriture de /etc/default/earlyoom impossible : rien n'a été modifié." };
    case 13: return { ok: false, reason: 'failed', message: "earlyoom n'a pas redémarré avec la nouvelle configuration : l'ancien fichier a été restauré." };
    default: return { ok: false, reason: 'failed', message: `Échec de l'application (code ${code}) : vérifier /etc/default/earlyoom et « systemctl status earlyoom ».` };
  }
}

/** Écrit `line` dans un fichier 0600 (mkdtemp sous os.tmpdir()), puis /usr/bin/pkexec /usr/bin/bash -c SCRIPT proc-watch-earlyoom <fichier> ; supprime le fichier dans finally. */
export async function applyEarlyoom(line: string, deps: { run?: ExecFn; tmpRoot?: string } = {}): Promise<ApplyResult> {
  if (!EARLYOOM_LINE_RE.test(line)) return { ok: false, reason: 'invalid', message: "Ligne non conforme : rien n'a été modifié." };
  const run = deps.run ?? defaultRun;
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), 'proc-watch-earlyoom-'));
    const file = join(dir, 'earlyoom');
    writeFileSync(file, `${line}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    const r = await run(PKEXEC, ['/usr/bin/bash', '-c', EARLYOOM_APPLY_SCRIPT, 'proc-watch-earlyoom', file], { timeout: APPLY_TIMEOUT_MS });
    return applyExitMessage(r.code, line);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return applyExitMessage(127, line);
    return { ok: false, reason: 'failed', message: `Échec de l'application : ${(e as Error)?.message ?? String(e)}` };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/** Gestionnaire d'`earlyoom:apply` : valide l'entrée, construit la ligne avec la liste protégée, un seul appel à la fois. */
export function createEarlyoomApplier(
  getProtected: () => readonly string[],
  apply: (line: string) => Promise<ApplyResult> = (line) => applyEarlyoom(line),
): (raw: unknown) => Promise<ApplyResult> {
  let busy = false;
  return async (raw) => {
    if (!isEarlyoomSettings(raw)) return { ok: false, reason: 'invalid', message: 'Réglages earlyoom invalides.' };
    const built = buildEarlyoomArgs(raw, getProtected());
    if (!built.ok) return { ok: false, reason: 'invalid', message: built.errors.join(' · ') };
    if (busy) return { ok: false, reason: 'failed', message: 'Une application est déjà en cours.' };
    busy = true;
    try {
      return await apply(built.line);
    } finally {
      busy = false;
    }
  };
}
