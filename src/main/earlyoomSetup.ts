// Installation et activation d'earlyoom depuis l'app (B8 bis) : un seul pkexec d'un script fixe.
import { buildEarlyoomArgs, checkEarlyoomLine, EARLYOOM_LINE_PATTERN } from '../core/earlyoom';
import {
  detectPackageManager, isSetupMode, PACKAGE_MANAGERS, setupNeed, setupSettings, type EarlyoomSetupMode, type PackageManagerName,
} from '../core/earlyoomSetup';
import type { ApplyResult, Config, EarlyoomStatus } from '../core/types';
import { applyExitMessage, defaultRun, EARLYOOM_SYSTEMCTL, EARLYOOM_TARGET, LINE_CHECKS, PKEXEC, writeAndStartFragment, type EarlyoomLock, type ExecFn } from './earlyoom';

export const EARLYOOM_BIN = '/usr/bin/earlyoom';
/** Installation : réseau et téléchargement compris. */
export const INSTALL_TIMEOUT_MS = 600_000;
/** Activation : seulement la saisie du mot de passe et le démarrage (comme « Appliquer »). */
export const ACTIVATE_TIMEOUT_MS = 120_000;
/** Le processus root ne peut pas être tué par l'utilisateur : au-delà du délai (+ marge), on cesse d'attendre. */
const GRACE_MS = 2_000;

if (EARLYOOM_LINE_PATTERN.includes("'")) throw new Error('motif earlyoom : apostrophe interdite');
for (const m of PACKAGE_MANAGERS) {
  if (!/^[a-z_]+$/.test(m.varName) || !/^\/usr\/bin\/[a-z-]+$/.test(m.path) || !m.args.every((a) => /^[A-Za-z0-9:=_-]+$/.test(a))) {
    throw new Error(`gestionnaire de paquets ${m.name} : constante non conforme`);
  }
}

const PM_VARS = PACKAGE_MANAGERS.map((m) => `${m.varName}=${m.path}`).join('\n');
const PM_BRANCHES = PACKAGE_MANAGERS.map((m, i) => `  ${i === 0 ? 'if' : 'elif'} [[ -x "$${m.varName}" ]]; then pm=("$${m.varName}" ${m.args.join(' ')})`).join('\n');

/**
 * Script fixe exécuté en root par `pkexec /usr/bin/bash -c SCRIPT proc-watch-earlyoom-setup <mode> <ligne>`.
 * Construit seulement à partir de constantes du module ; ne lit AUCUNE variable d'environnement (PATH, locale, umask fixés).
 * - exactement deux arguments : le mode, comparé à l'identique à `install` ou `activate` (jamais interprété), puis la ligne,
 *   revalidée par la même politique qu'« Appliquer » (LINE_CHECKS) ; tout est validé AVANT la moindre action ;
 * - install : le gestionnaire de paquets est choisi ici, par chemin absolu (pacman, apt-get, dnf, zypper, dans cet ordre),
 *   et le paquet est le nom constant `earlyoom` ; installation non interactive (stdin /dev/null), sortie sur stderr (5 lignes) ;
 * - puis /usr/bin/earlyoom doit exister ; sauvegarde .bak, écriture, `enable --now` + `restart` (la nouvelle ligne est lue
 *   même si le paquet a déjà démarré le service), vérification (NRestarts + is-active), sinon restauration.
 * Codes : 10 arguments ou mode refusés, 11 ligne refusée, 12 écriture impossible, 13 inactif (ancien fichier restauré),
 * 14 restauration impossible (.bak sur stdout), 15 restauré mais ne redémarre pas, 20 gestionnaire inconnu,
 * 21 installation en échec, 22 /usr/bin/earlyoom absent.
 */
export const EARLYOOM_SETUP_SCRIPT = `set -u
umask 022
export PATH=/usr/bin:/bin LC_ALL=C
(( $# == 2 )) || exit 10
mode="$1"
line="$2"
target=${EARLYOOM_TARGET}
systemctl=${EARLYOOM_SYSTEMCTL}
earlyoom=${EARLYOOM_BIN}
${PM_VARS}
pause=2
re='${EARLYOOM_LINE_PATTERN}'
[[ "$mode" == install || "$mode" == activate ]] || exit 10
${LINE_CHECKS}if [[ "$mode" == install ]]; then
${PM_BRANCHES}
  else exit 20
  fi
  out=$(DEBIAN_FRONTEND=noninteractive "\${pm[@]}" < /dev/null 2>&1)
  rc=$?
  printf '%s\\n' "$out" | tail -n 5 >&2
  (( rc == 0 )) || exit 21
fi
[[ -x "$earlyoom" ]] || exit 22
${writeAndStartFragment('  "$systemctl" enable --now earlyoom || return 1\n  "$systemctl" restart earlyoom || return 1')}`;

/** Dernière ligne non vide de la sortie du gestionnaire, sans caractères de contrôle, 200 caractères au plus. */
function lastLine(stderr: string): string {
  const clean = stderr.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  const l = clean.split('\n').map((x) => x.trim()).filter(Boolean).at(-1) ?? '';
  return l.length > 200 ? `${l.slice(0, 200)}…` : l;
}

export function setupExitMessage(code: number, mode: EarlyoomSetupMode, line: string, stdout: string, stderr: string): ApplyResult {
  switch (code) {
    case 10: return { ok: false, reason: 'invalid', message: "Demande refusée par le script (mode ou arguments) : rien n'a été modifié." };
    case 20: return { ok: false, reason: 'unavailable', message: "Gestionnaire de paquets non reconnu (pacman, apt-get, dnf ou zypper attendu) : installer earlyoom à la main ; rien n'a été modifié." };
    case 21: {
      const detail = lastLine(stderr);
      return {
        ok: false, reason: 'failed',
        message: `Échec de l’installation du paquet earlyoom (réseau, dépôts ou gestionnaire de paquets occupé) : /etc/default/earlyoom n'a pas été modifié.${detail ? ` Dernier message : ${detail}` : ''}`,
      };
    }
    case 22: return { ok: false, reason: 'failed', message: `earlyoom introuvable (${EARLYOOM_BIN})${mode === 'install' ? ' après l’installation' : ''} : rien n'a été modifié.` };
    default: return applyExitMessage(code, line, stdout);
  }
}

export interface SetupOutcome {
  result: ApplyResult;
  /** Code de sortie (null : délai dépassé ou lancement impossible). */
  code: number | null;
  timedOut: boolean;
  /** Fin réelle du processus (après un délai dépassé, le bash root continue : on ne relance rien avant). */
  done: Promise<unknown>;
}

const timeoutMessage = (mode: EarlyoomSetupMode): ApplyResult => ({
  ok: false,
  reason: 'failed',
  message: mode === 'install'
    ? 'Délai dépassé (10 min) : l’installation continue peut-être en arrière-plan ; rouvrir Réglages › earlyoom pour vérifier son état.'
    : "Délai dépassé (120 s) : rien n'a été modifié si la fenêtre de mot de passe était encore ouverte.",
});

/** `/usr/bin/pkexec /usr/bin/bash -c SCRIPT proc-watch-earlyoom-setup <mode> <ligne>` : argv figé, aucun fichier, aucune variable. */
export async function setupEarlyoom(mode: EarlyoomSetupMode, line: string, deps: { run?: ExecFn; timeoutMs?: number } = {}): Promise<SetupOutcome> {
  const settled = Promise.resolve();
  if (!isSetupMode(mode)) return { result: setupExitMessage(10, 'activate', line, '', ''), code: null, timedOut: false, done: settled };
  const bad = checkEarlyoomLine(line);
  if (bad) return { result: { ok: false, reason: 'invalid', message: `${bad} : rien n'a été modifié.` }, code: null, timedOut: false, done: settled };
  const run = deps.run ?? defaultRun;
  const limit = deps.timeoutMs ?? (mode === 'install' ? INSTALL_TIMEOUT_MS : ACTIVATE_TIMEOUT_MS);
  type Done = { code: number; stdout: string; stderr: string; timedOut?: boolean } | { error: unknown };
  const proc: Promise<Done> = (async () => {
    try {
      return await run(PKEXEC, ['/usr/bin/bash', '-c', EARLYOOM_SETUP_SCRIPT, 'proc-watch-earlyoom-setup', mode, line], { timeout: limit });
    } catch (error) {
      return { error };
    }
  })();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((res) => (timer = setTimeout(() => res('late'), limit + (deps.timeoutMs === undefined ? GRACE_MS : 0))));
  const r = await Promise.race([proc, late]);
  clearTimeout(timer);
  if (r === 'late') return { result: timeoutMessage(mode), code: null, timedOut: true, done: proc };
  if ('error' in r) {
    if ((r.error as NodeJS.ErrnoException)?.code === 'ENOENT') return { result: applyExitMessage(127, line), code: null, timedOut: false, done: settled };
    return { result: { ok: false, reason: 'failed', message: `Échec : ${(r.error as Error)?.message ?? String(r.error)}` }, code: null, timedOut: false, done: settled };
  }
  if (r.timedOut) return { result: timeoutMessage(mode), code: null, timedOut: true, done: settled };
  return { result: setupExitMessage(r.code, mode, line, r.stdout, r.stderr), code: r.code, timedOut: false, done: settled };
}

/** Texte de la confirmation native : paquet et gestionnaire, ligne exacte, activation du service. */
export function setupConfirmation(mode: EarlyoomSetupMode, pm: PackageManagerName | null, line: string): { message: string; detail: string; confirm: string } {
  const m = PACKAGE_MANAGERS.find((x) => x.name === pm);
  const parts = [
    ...(mode === 'install' && m ? [`Paquet : earlyoom, installé avec ${m.name} (${m.name} ${m.args.join(' ')}).`] : []),
    `Ligne écrite dans ${EARLYOOM_TARGET} (l'ancien fichier est copié en .bak) :\n${line}`,
    'Service : systemctl enable --now earlyoom (démarré maintenant et à chaque démarrage). Si earlyoom ne reste pas actif, l’ancien fichier est restauré.',
    'Le mot de passe administrateur est demandé une seule fois.',
  ];
  return mode === 'install'
    ? { message: 'Installer et configurer earlyoom ?', detail: parts.join('\n\n'), confirm: 'Installer et configurer' }
    : { message: 'Configurer et activer earlyoom ?', detail: parts.join('\n\n'), confirm: 'Activer' };
}

export interface SetupEvent {
  ts: number;
  type: 'earlyoom_setup';
  groupKey: null;
  detail: { mode: EarlyoomSetupMode; ok: boolean; code: number | null; timedOut?: true };
}

/**
 * Gestionnaire d'`earlyoom:setup` : le renderer ne fournit qu'un mot-clé (`install` | `activate`), qui doit correspondre à
 * l'état relu par le main. Le main construit la ligne (réglages du fichier existant s'ils sont valides, sinon par défaut ;
 * exclusions de sa liste protégée), demande confirmation, puis lance un seul pkexec. Un seul à la fois, jusqu'à la vraie fin.
 */
export function createEarlyoomSetup(deps: {
  status: () => Promise<EarlyoomStatus>;
  getProtected: () => readonly string[];
  exists: (p: string) => boolean;
  confirm: (c: { mode: EarlyoomSetupMode; pm: PackageManagerName | null; line: string }) => Promise<boolean>;
  setup?: (mode: EarlyoomSetupMode, line: string) => Promise<SetupOutcome>;
  log: (e: SetupEvent) => void;
  now?: () => number;
  /** Verrou partagé avec « Appliquer ». */
  lock?: EarlyoomLock;
}): (rawMode: unknown) => Promise<ApplyResult> {
  const setup = deps.setup ?? ((mode, line) => setupEarlyoom(mode, line));
  const now = deps.now ?? Date.now;
  const lock = deps.lock ?? { held: false };
  return async (rawMode) => {
    if (!isSetupMode(rawMode)) return { ok: false, reason: 'invalid', message: 'Demande invalide : rien n’a été modifié.' };
    if (lock.held) return { ok: false, reason: 'failed', message: 'Une installation ou une application est déjà en cours.' };
    lock.held = true;
    let release = true;
    try {
      const st = await deps.status();
      const need = setupNeed(st);
      if (need !== rawMode) {
        return { ok: false, reason: 'stale', message: `L’état d’earlyoom a changé (${need === null ? 'rien à faire' : need === 'install' ? 'non installé' : 'installé mais inactif'}) : rien n’a été modifié.` };
      }
      const pm = rawMode === 'install' ? detectPackageManager(deps.exists) : null;
      if (rawMode === 'install' && !pm) return setupExitMessage(20, rawMode, '', '', '');
      const built = buildEarlyoomArgs(setupSettings(st.file), deps.getProtected());
      if (!built.ok) return { ok: false, reason: 'invalid', message: built.errors.join(' · ') };
      if (!(await deps.confirm({ mode: rawMode, pm, line: built.line }))) return { ok: false, reason: 'cancelled', message: "Annulé : rien n'a été modifié." };
      const o = await setup(rawMode, built.line);
      deps.log({ ts: now(), type: 'earlyoom_setup', groupKey: null, detail: { mode: rawMode, ok: o.result.ok, code: o.code, ...(o.timedOut ? { timedOut: true as const } : {}) } });
      release = false;
      void o.done.finally(() => (lock.held = false));
      return o.result;
    } finally {
      if (release) lock.held = false;
    }
  };
}

/** « Ne plus rappeler pendant 7 jours » : horodatage pris par le main (le renderer n'en fournit aucun). */
export function snoozeReminder(config: Config, now: number): Config {
  return { ...config, earlyoomReminder: { snoozedAt: now } };
}

/** config:set : le rappel appartient au main ; celui envoyé par le renderer est ignoré (ni ajouté, ni effacé, ni avancé). */
export function keepEarlyoomReminder(next: Config, current: Config): Config {
  const { earlyoomReminder: _ignored, ...rest } = next;
  return current.earlyoomReminder ? { ...rest, earlyoomReminder: current.earlyoomReminder } : rest;
}
