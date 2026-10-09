// Familles root de la page Disque (cache de paquets, journaux) : un seul pkexec d'un script figé, comme earlyoomSetup.
// `pkexec /usr/bin/bash -c SCRIPT computer-watcher-disk <pkg-cache|journal>` : aucun chemin ni aucune variable en argument.
import { PKEXEC, defaultRun } from './earlyoom';

export type RootAction = 'pkg-cache' | 'journal';
export const ROOT_ACTIONS: readonly RootAction[] = ['pkg-cache', 'journal'];
const isRootAction = (v: unknown): v is RootAction => typeof v === 'string' && (ROOT_ACTIONS as readonly string[]).includes(v);

/** Chemins absolus des outils (remplaçables seulement pour les tests du script, jamais à l'exécution réelle). */
export interface RootBins { paccache: string; pacman: string; aptGet: string; journalctl: string; osRelease: string }
const REAL_BINS: RootBins = {
  paccache: '/usr/bin/paccache', pacman: '/usr/bin/pacman', aptGet: '/usr/bin/apt-get', journalctl: '/usr/bin/journalctl', osRelease: '/etc/os-release',
};

for (const p of Object.values(REAL_BINS)) if (!/^\/[A-Za-z0-9/_.-]+$/.test(p)) throw new Error(`diskRoot : chemin non conforme ${p}`);

/**
 * Script root figé. Exactement un argument, comparé à l'identique ; tout le reste est constant. Environnement vidé pour les
 * outils (`env -i`), PATH et locale fixés, /etc/os-release lu ligne à ligne (jamais exécuté).
 * - pkg-cache : distribution de la famille Arch (ID / ID_LIKE), ou pacman seul présent → `paccache -rk2` (65 si paccache,
 *   du paquet pacman-contrib, manque) ; famille Debian, ou apt-get seul présent → `apt-get clean` ; sinon 66 ;
 * - journal : `journalctl --vacuum-size=500M` ;
 * - 64 : argument refusé ; 67 : outil introuvable (chaque binaire est vérifié avec -x avant l'appel : le script ne
 *   renvoie jamais 126 ni 127, réservés à pkexec).
 */
export function diskRootScript(b: RootBins): string {
  for (const p of Object.values(b)) if (!/^\/[A-Za-z0-9/_.-]+$/.test(p)) throw new Error(`diskRoot : chemin non conforme ${p}`);
  return `set -u
umask 022
export PATH=/usr/bin:/bin LC_ALL=C
(( $# == 1 )) || exit 64
action="$1"
paccache=${b.paccache}
pacman=${b.pacman}
aptget=${b.aptGet}
journalctl=${b.journalctl}
osrelease=${b.osRelease}
[[ -x /usr/bin/env ]] || exit 67
run() { [[ -x "$1" ]] || exit 67; /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C "$@" < /dev/null; }
case "$action" in
  pkg-cache)
    ids=""
    if [[ -f "$osrelease" ]]; then
      while IFS= read -r l || [[ -n "$l" ]]; do
        case "$l" in
          ID=*|ID_LIKE=*) ids+=" \${l#*=}" ;;
        esac
      done < "$osrelease"
    fi
    ids=\${ids//[\\"\\']/ }
    read -r -a words <<< "$ids"
    arch=0
    debian=0
    for w in "\${words[@]}"; do
      case "$w" in
        arch|manjaro|endeavouros|garuda|artix|cachyos) arch=1 ;;
        debian|ubuntu|linuxmint|pop|elementary|zorin) debian=1 ;;
      esac
    done
    if (( arch == 0 && debian == 0 )); then
      [[ -x "$pacman" && ! -x "$aptget" ]] && arch=1
      [[ -x "$aptget" && ! -x "$pacman" ]] && debian=1
    fi
    if (( arch == 1 && debian == 0 )) && [[ -x "$pacman" ]]; then
      [[ -x "$paccache" ]] || exit 65
      run "$paccache" -rk2
      exit $?
    fi
    if (( debian == 1 && arch == 0 )) && [[ -x "$aptget" ]]; then
      run "$aptget" clean
      exit $?
    fi
    exit 66
    ;;
  journal)
    run "$journalctl" --vacuum-size=500M
    exit $?
    ;;
  *) exit 64 ;;
esac
`;
}

export const DISK_ROOT_SCRIPT = diskRootScript(REAL_BINS);
export const DISK_ROOT_ARGV0 = 'computer-watcher-disk';

export function diskRootArgv(action: RootAction): string[] {
  return ['/usr/bin/bash', '-c', DISK_ROOT_SCRIPT, DISK_ROOT_ARGV0, action];
}

/** Délai : saisie du mot de passe comprise. */
const ROOT_TIMEOUT_MS = 300_000;

export type RootRun = (cmd: string, args: string[], o: { timeout: number }) => Promise<{ code: number; stderr: string }>;

const lastLine = (s: string) => {
  const l = s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').split('\n').map((x) => x.trim()).filter(Boolean).at(-1) ?? '';
  return l.length > 200 ? `${l.slice(0, 200)}…` : l;
};

export async function runDiskRoot(action: RootAction, run: RootRun): Promise<{ ok: boolean; cancelled: boolean; error?: string }> {
  if (!isRootAction(action)) return { ok: false, cancelled: false, error: 'action refusée' };
  let r: { code: number; stderr: string };
  try {
    r = await run(PKEXEC, diskRootArgv(action), { timeout: ROOT_TIMEOUT_MS });
  } catch (e) {
    return { ok: false, cancelled: false, error: (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'pkexec indisponible' : (e as Error)?.message ?? String(e) };
  }
  switch (r.code) {
    case 0: return { ok: true, cancelled: false };
    case 126: return { ok: false, cancelled: true };
    // pkexec : authentification refusée ; une commande introuvable (message « not found ») n'est pas un refus
    case 127:
      return /not found|introuvable|no such file/i.test(r.stderr)
        ? { ok: false, cancelled: false, error: `outil introuvable (code 127)${lastLine(r.stderr) ? ` : ${lastLine(r.stderr)}` : ''}` }
        : { ok: false, cancelled: true };
    case 64: return { ok: false, cancelled: false, error: 'demande refusée par le script' };
    case 65: return { ok: false, cancelled: false, error: 'indisponible : installer pacman-contrib (paccache)' };
    case 67: return { ok: false, cancelled: false, error: 'outil introuvable sur ce système (rien n’a été modifié)' };
    case 66: return { ok: false, cancelled: false, error: 'distribution non prise en charge (ni pacman, ni apt-get)' };
    default: {
      const l = lastLine(r.stderr);
      return { ok: false, cancelled: false, error: `échec (code ${r.code})${l ? ` : ${l}` : ''}` };
    }
  }
}

/**
 * Lanceur de pkexec. `PROC_WATCH_DISK_ROOT_FAKE=1` hors paquet (développement, bout en bout) : rien n'est lancé, succès
 * simulé. Une app empaquetée l'ignore toujours.
 */
export function diskRootRunner(env: NodeJS.ProcessEnv, isPackaged: boolean): { fake: boolean; run: RootRun } {
  if (!isPackaged && env.PROC_WATCH_DISK_ROOT_FAKE === '1') return { fake: true, run: async () => ({ code: 0, stderr: '' }) };
  return { fake: false, run: (cmd, args, o) => defaultRun(cmd, args, o) };
}

/** Raison d'indisponibilité d'une famille root sur ce système (null : disponible). */
export function rootUnavailable(id: RootAction, exists: (p: string) => boolean): string | null {
  if (id === 'journal') return exists(REAL_BINS.journalctl) ? null : 'indisponible : journalctl absent';
  if (exists(REAL_BINS.pacman)) return exists(REAL_BINS.paccache) ? null : 'indisponible : installer pacman-contrib (paccache)';
  return exists(REAL_BINS.aptGet) ? null : 'indisponible : distribution non prise en charge';
}
