// État d'earlyoom et application d'une nouvelle configuration via pkexec d'un script fixe.
import { execFile } from 'node:child_process';
import { cleanEnv } from '../core/childEnv';
import { existsSync, readFileSync } from 'node:fs';
import { buildEarlyoomArgs, checkEarlyoomLine, EARLYOOM_LINE_PATTERN, EARLYOOM_MAX_LINE, isEarlyoomSettings, parseEarlyoomDefault } from '../core/earlyoom';
import type { ApplyResult, EarlyoomStatus } from '../core/types';

export type ExecFn = (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }>;

export const EARLYOOM_TARGET = '/etc/default/earlyoom';
export const EARLYOOM_SYSTEMCTL = '/usr/bin/systemctl';
export const PKEXEC = '/usr/bin/pkexec';
export const EARLYOOM_INSTALL_HINT = 'sudo pacman -S earlyoom && sudo systemctl enable --now earlyoom';
const APPLY_TIMEOUT_MS = 120_000; // saisie du mot de passe

/** execFile qui résout avec le code de sortie ; rejette seulement si la commande est introuvable (ENOENT). */
export const defaultRun: ExecFn = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts?.timeout ?? 10_000, maxBuffer: 1 << 20, encoding: 'utf8', env: cleanEnv(process.env) }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(err);
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0;
      const timedOut = !!err && (err as { killed?: boolean }).killed === true;
      resolve({ code, stdout: String(stdout), stderr: String(stderr), timedOut });
    });
  });

const readText = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

/** Sortie de `systemctl is-enabled` : enabled, disabled, masked (et -runtime), autre valeur connue → other, rien → unknown. */
export function parseIsEnabled(out: string | undefined): EarlyoomStatus['enabled'] {
  const s = (out ?? '').trim().split('\n')[0]?.trim() ?? '';
  if (s === 'enabled' || s === 'enabled-runtime') return 'enabled';
  if (s === 'disabled') return 'disabled';
  if (s === 'masked' || s === 'masked-runtime') return 'masked';
  return /^[a-z-]+$/.test(s) ? 'other' : 'unknown';
}

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
  let enabled: EarlyoomStatus['enabled'] = 'unknown';
  if (installed) {
    // Chemins absolus seulement (binaire, systemctl) : aucune recherche dans le PATH.
    const [v, a, e] = await Promise.all([
      run(bin, ['-v'], { timeout: 5000 }).catch(() => null),
      run(EARLYOOM_SYSTEMCTL, ['is-active', 'earlyoom'], { timeout: 5000 }).catch(() => null),
      run(EARLYOOM_SYSTEMCTL, ['is-enabled', 'earlyoom'], { timeout: 5000 }).catch(() => null),
    ]);
    version = (v ? `${v.stdout}\n${v.stderr}` : '').match(/earlyoom\s+v?(\d[\w.+-]*)/)?.[1] ?? null;
    const s = a?.stdout.trim();
    if (s === 'active' || s === 'inactive' || s === 'failed') active = s;
    enabled = parseIsEnabled(e?.stdout);
  }
  const text = read(EARLYOOM_TARGET);
  return { installed, version, active, enabled, file: text === null ? null : parseEarlyoomDefault(text), installHint: EARLYOOM_INSTALL_HINT };
}


// Le motif bash vient de la même constante que EARLYOOM_LINE_RE (grammaire EARLYOOM_TOKEN_CHARS, base en littéral).
if (EARLYOOM_LINE_PATTERN.includes("'")) throw new Error('motif earlyoom : apostrophe interdite');

/**
 * Script fixe exécuté en root par pkexec (`bash -c`, pas de fichier .sh : dans une AppImage les fichiers de
 * l'app vivent sous un montage FUSE illisible par root). Il n'est construit qu'à partir de constantes du module
 * (jamais d'une entrée) et ne lit AUCUNE variable d'environnement : cible, systemctl, PATH et locale sont fixés.
 *
 * La ligne arrive en argument ($1), jamais par un fichier : l'argv est figé dès que pkexec est lancé (aucun autre
 * processus ne peut la changer pendant la saisie du mot de passe) et root n'ouvre aucun chemin fourni par l'appelant.
 *
 * Il applique la POLITIQUE, pas seulement la forme : bornes de -m (1–50) et -s (1–100), SIGKILL ≤ SIGTERM, -r 0,
 * exclusions de base en tête et dans l'ordre, motifs limités à des jetons [A-Za-z0-9_.-]+ suivis ou non de « .* ».
 * Puis : copie de l'ancien fichier en .bak-<date à la ms>[.n] (jamais écrasée), écriture atomique, redémarrage,
 * attente de 2 s et vérification (actif, NRestarts inchangé) ; sinon restauration, redémarrage et même vérification.
 * Codes : 10 argument absent, 11 ligne refusée, 12 écriture impossible, 13 earlyoom inactif avec la nouvelle
 * configuration (ancien fichier restauré), 14 restauration impossible (chemin du .bak sur la sortie standard),
 * 15 ancien fichier restauré mais earlyoom ne redémarre pas.
 */
/** Contrôles de la ligne ($line) : non vide, longueur, motif (forme, bornes, base, jetons), SIGKILL ≤ SIGTERM ; sinon 11 (10 si vide). */
export const LINE_CHECKS = `[[ -n "$line" ]] || exit 10
(( \${#line} <= ${EARLYOOM_MAX_LINE} )) || exit 11
[[ "$line" =~ $re ]] || exit 11
(( BASH_REMATCH[2] <= BASH_REMATCH[1] && BASH_REMATCH[4] <= BASH_REMATCH[3] )) || exit 11
`;

/**
 * Sauvegarde (.bak-<date à la ms>[.n], jamais écrasée), écriture atomique, démarrage vérifié et restauration :
 * commun à « Appliquer » et à l'installation. `start` : commandes de démarrage (dans start_and_check, `|| return 1`) ;
 * `restoreEnd` : fin de restore(), après la remise de l'ancien fichier (défaut : redémarrage vérifié, 13 ou 15).
 */
export const writeAndStartFragment = (start: string, restoreEnd = '  start_and_check || exit 15\n  exit 13'): string => `bak=""
if [[ -e "$target" ]]; then
  bak="$target.bak-$(date +%Y%m%dT%H%M%S.%3N)"
  first="$bak"
  i=0
  while [[ -e "$bak" || -L "$bak" ]]; do i=$((i + 1)); bak="$first.$i"; done
  cp -p -- "$target" "$bak" || exit 12
fi
{ printf '%s\\n' "$line" > "$target.computer-watcher.tmp" && chmod 644 "$target.computer-watcher.tmp" && mv -f -- "$target.computer-watcher.tmp" "$target"; } || { rm -f -- "$target.computer-watcher.tmp"; exit 12; }
# Redémarre puis vérifie au bout de $pause s : service actif et aucun redémarrage automatique entre-temps.
# NRestarts est lu juste après le restart manuel (qui remet le compteur à zéro) puis après l'attente :
# une hausse signale une boucle de plantages (Restart=always) même si le service est vu actif.
start_and_check() {
${start}
  local n1 n2
  n1=$("$systemctl" show -p NRestarts --value earlyoom)
  sleep "$pause"
  n2=$("$systemctl" show -p NRestarts --value earlyoom)
  [[ "$n1" == "$n2" ]] || return 1
  "$systemctl" is-active --quiet earlyoom
}
restore() {
  if [[ -n "$bak" ]]; then
    cp -p -- "$bak" "$target" || { printf '%s\\n' "$bak"; exit 14; }
  else
    rm -f -- "$target" || exit 14
  fi
${restoreEnd}
}
start_and_check || restore
exit 0
`;

export const EARLYOOM_APPLY_SCRIPT = `set -u
export PATH=/usr/bin:/bin LC_ALL=C
line="\${1:-}"
target=${EARLYOOM_TARGET}
systemctl=${EARLYOOM_SYSTEMCTL}
pause=2
re='${EARLYOOM_LINE_PATTERN}'
${LINE_CHECKS}${writeAndStartFragment('  "$systemctl" restart earlyoom || return 1')}`;

const BAK_PATH_RE = new RegExp(`^${EARLYOOM_TARGET.replace(/[.]/g, '\\.')}\\.bak-[0-9T.]+$`);

export function applyExitMessage(code: number, line: string, stdout = ''): ApplyResult {
  switch (code) {
    case 0: return { ok: true, line };
    case 126: return { ok: false, reason: 'cancelled', message: "Authentification annulée : rien n'a été modifié." };
    case 127: return { ok: false, reason: 'unavailable', message: "Autorisation refusée ou pkexec indisponible : rien n'a été modifié." };
    case 10:
    case 11: return { ok: false, reason: 'invalid', message: "Ligne refusée par le script de vérification : rien n'a été modifié." };
    case 12: return { ok: false, reason: 'failed', message: "Écriture de /etc/default/earlyoom impossible : rien n'a été modifié." };
    case 13: return { ok: false, reason: 'failed', message: "earlyoom n'est pas resté actif avec la nouvelle configuration : l'ancien fichier a été restauré." };
    case 14: {
      const bak = stdout.trim();
      return { ok: false, reason: 'failed', message: `Restauration impossible : voir ${BAK_PATH_RE.test(bak) ? bak : `${EARLYOOM_TARGET}.bak-…`}` };
    }
    case 15: return { ok: false, reason: 'failed', message: 'earlyoom arrêté : ancienne config restaurée mais le service ne redémarre pas.' };
    default: return { ok: false, reason: 'failed', message: `Échec de l'application (code ${code}) : vérifier /etc/default/earlyoom et « systemctl status earlyoom ».` };
  }
}

/** /usr/bin/pkexec /usr/bin/bash -c SCRIPT computer-watcher-earlyoom "<ligne>" : la ligne passe en argument, aucun fichier. */
export async function applyEarlyoom(line: string, deps: { run?: ExecFn } = {}): Promise<ApplyResult> {
  const bad = checkEarlyoomLine(line);
  if (bad) return { ok: false, reason: 'invalid', message: `${bad} : rien n'a été modifié.` };
  const run = deps.run ?? defaultRun;
  try {
    const r = await run(PKEXEC, ['/usr/bin/bash', '-c', EARLYOOM_APPLY_SCRIPT, 'computer-watcher-earlyoom', line], { timeout: APPLY_TIMEOUT_MS });
    if (r.timedOut) return { ok: false, reason: 'failed', message: "Délai dépassé (120 s) : rien n'a été modifié si la fenêtre de mot de passe était encore ouverte." };
    return applyExitMessage(r.code, line, r.stdout);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return applyExitMessage(127, line);
    return { ok: false, reason: 'failed', message: `Échec de l'application : ${(e as Error)?.message ?? String(e)}` };
  }
}

/** Un seul script root earlyoom à la fois (« Appliquer », installation, activation). */
export interface EarlyoomLock { held: boolean }

/**
 * Gestionnaire d'`earlyoom:apply` : valide les réglages, reconstruit la ligne avec la liste protégée du main, refuse
 * si elle diffère de l'aperçu du renderer, demande confirmation dans le main (ligne exacte), puis pkexec.
 * Un seul appel à la fois, confirmation comprise.
 */
export function createEarlyoomApplier(
  getProtected: () => readonly string[],
  confirm: (line: string) => Promise<boolean>,
  apply: (line: string) => Promise<ApplyResult> = (line) => applyEarlyoom(line),
  /** Verrou partagé avec l'installation (B8 bis) : jamais deux pkexec earlyoom en même temps. */
  lock: EarlyoomLock = { held: false },
): (raw: unknown, expectedLine: unknown) => Promise<ApplyResult> {
  return async (raw, expectedLine) => {
    if (!isEarlyoomSettings(raw)) return { ok: false, reason: 'invalid', message: 'Réglages earlyoom invalides.' };
    const built = buildEarlyoomArgs(raw, getProtected());
    if (!built.ok) return { ok: false, reason: 'invalid', message: built.errors.join(' · ') };
    if (expectedLine !== built.line) {
      return { ok: false, reason: 'invalid', message: "La ligne de l'aperçu ne correspond plus à la configuration (liste protégée modifiée ?) : rien n'a été modifié, rouvrir les Réglages." };
    }
    if (lock.held) return { ok: false, reason: 'failed', message: 'Une application est déjà en cours.' };
    lock.held = true;
    try {
      if (!(await confirm(built.line))) return { ok: false, reason: 'cancelled', message: "Annulé : rien n'a été modifié." };
      return await apply(built.line);
    } finally {
      lock.held = false;
    }
  };
}
