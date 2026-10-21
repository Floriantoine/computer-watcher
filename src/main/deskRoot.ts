// Bureau prioritaire, mise à niveau root : protection mémoire (MemoryLow) des niveaux système au-dessus de la session, par
// trois drop-ins systemd et `systemctl daemon-reload`. Même mécanique que earlyoomSetup et diskRoot : un seul pkexec d'un
// script figé, `pkexec /usr/bin/bash -c SCRIPT computer-watcher-desk <install|remove> <Mo|0>`, aucun chemin ni variable en
// argument, confirmation native dans le main qui montre les fichiers et la commande.
import { execFile } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { cleanEnv } from '../core/childEnv';
import {
  DESK_ROOT_DROPINS, DESK_ROOT_ETC, DESK_ROOT_HEADER, DESK_ROOT_MAX_MB, DESK_ROOT_MIN_MB, DESK_ROOT_NAME, deskRootContent, deskRootLevels, deskRootStatus,
  deskRootTargetMB, isDeskRootMB, type DeskRootStatus,
} from '../core/antigel/deskRoot';
import { sliceLimits } from '../core/antigel/limits';
import { PKEXEC, defaultRun } from './earlyoom';

export type DeskRootMode = 'install' | 'remove';
const isMode = (v: unknown): v is DeskRootMode => v === 'install' || v === 'remove';

export const DESK_ROOT_SYSTEMCTL = '/usr/bin/systemctl';
export const DESK_ROOT_ARGV0 = 'computer-watcher-desk';
const PATH_RE = /^\/[A-Za-z0-9/_.@-]+$/;

/**
 * Script root figé. Exactement deux arguments, comparés à l'identique (le mode) ou au motif (la valeur, en Mo, chiffres sans
 * zéro initial, bornée) ; tout le reste est constant. PATH, locale et umask fixés ; aucune variable d'environnement lue.
 * - install : les trois fichiers sont écrits d'abord en .tmp (644), puis renommés ; un dossier en lien symbolique est refusé ;
 *   puis `systemctl daemon-reload` (applique MemoryLow aux unités en cours) ;
 * - remove : retire nos trois fichiers (jamais un autre), puis les dossiers s'ils sont vides, puis `daemon-reload`.
 * Codes : 64 arguments refusés, 65 valeur refusée, 66 écriture impossible (rien de modifié), 67 systemctl introuvable,
 * 68 daemon-reload en échec, 69 renommage interrompu (nos fichiers retirés). Jamais 126 ni 127 (réservés à pkexec).
 */
export function deskRootScript(p: { etc: string; systemctl: string }): string {
  for (const v of [p.etc, p.systemctl]) if (!PATH_RE.test(v)) throw new Error(`deskRoot : chemin non conforme ${v}`);
  const header = DESK_ROOT_HEADER.map((l) => `"${l}"`).join(' ');
  return `set -u
umask 022
export PATH=/usr/bin:/bin LC_ALL=C
(( $# == 2 )) || exit 64
mode="$1"
mb="$2"
etc=${p.etc}
systemctl=${p.systemctl}
name=${DESK_ROOT_NAME}
dirs=(${DESK_ROOT_DROPINS.map((d) => d.dir).join(' ')})
sections=(${DESK_ROOT_DROPINS.map((d) => d.section).join(' ')})
case "$mode" in
  install)
    [[ "$mb" =~ ^[1-9][0-9]{0,6}$ ]] || exit 65
    (( mb >= ${DESK_ROOT_MIN_MB} && mb <= ${DESK_ROOT_MAX_MB} )) || exit 65
    ;;
  remove) [[ "$mb" == 0 ]] || exit 64 ;;
  *) exit 64 ;;
esac
[[ -x "$systemctl" ]] || exit 67
[[ -d "$etc" && ! -L "$etc" ]] || exit 66
for d in "\${dirs[@]}"; do [[ -L "$etc/$d" ]] && exit 66; done
reload() { "$systemctl" daemon-reload < /dev/null || exit 68; }
drop() {
  local d
  for d in "\${dirs[@]}"; do
    rm -f -- "$etc/$d/$name" "$etc/$d/$name.tmp"
    [[ -d "$etc/$d" ]] && rmdir -- "$etc/$d" 2>/dev/null
  done
  return 0
}
if [[ "$mode" == remove ]]; then
  drop
  for d in "\${dirs[@]}"; do [[ -e "$etc/$d/$name" ]] && exit 66; done
  reload
  exit 0
fi
for i in "\${!dirs[@]}"; do
  d="$etc/\${dirs[$i]}"
  if ! { mkdir -p -- "$d" && rm -f -- "$d/$name.tmp" && printf '%s\\n' ${header} "[\${sections[$i]}]" "MemoryLow=\${mb}M" > "$d/$name.tmp" && chmod 644 -- "$d/$name.tmp"; }; then
    for x in "\${dirs[@]}"; do rm -f -- "$etc/$x/$name.tmp"; done
    exit 66
  fi
done
for d in "\${dirs[@]}"; do
  mv -f -- "$etc/$d/$name.tmp" "$etc/$d/$name" || { drop; reload; exit 69; }
done
reload
exit 0
`;
}

export const DESK_ROOT_SCRIPT = deskRootScript({ etc: DESK_ROOT_ETC, systemctl: DESK_ROOT_SYSTEMCTL });

/** argv de pkexec : le script figé, le mode et la valeur (0 pour un retrait). */
export function deskRootArgv(mode: DeskRootMode, mb: number | null, script = DESK_ROOT_SCRIPT): string[] {
  if (!isMode(mode)) throw new Error('mode refusé');
  if (mode === 'install' && !isDeskRootMB(mb)) throw new Error(`valeur refusée : ${mb}`);
  return ['/usr/bin/bash', '-c', script, DESK_ROOT_ARGV0, mode, mode === 'install' ? String(mb) : '0'];
}

export interface DeskRootResult {
  ok: boolean;
  reason?: 'cancelled' | 'invalid' | 'stale' | 'failed' | 'unavailable';
  message: string;
  status?: DeskRootStatus;
}

const lastLine = (s: string) => {
  const l = s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').split('\n').map((x) => x.trim()).filter(Boolean).at(-1) ?? '';
  return l.length > 200 ? `${l.slice(0, 200)}…` : l;
};

export function deskRootExitMessage(code: number, mode: DeskRootMode, stderr: string): DeskRootResult {
  const what = mode === 'install' ? 'Protection mémoire système' : 'Retrait de la protection mémoire système';
  switch (code) {
    case 0: return { ok: true, message: mode === 'install' ? 'Protection mémoire système posée.' : 'Protection mémoire système retirée.' };
    case 126: return { ok: false, reason: 'cancelled', message: 'Authentification annulée : rien n’a été modifié.' };
    // pkexec : authentification refusée ; une commande introuvable (« not found ») n'en est pas une
    case 127:
      return /not found|introuvable|no such file/i.test(stderr)
        ? { ok: false, reason: 'unavailable', message: 'pkexec ou bash introuvable : rien n’a été modifié.' }
        : { ok: false, reason: 'cancelled', message: 'Autorisation refusée : rien n’a été modifié.' };
    case 64:
    case 65: return { ok: false, reason: 'invalid', message: 'Demande refusée par le script : rien n’a été modifié.' };
    case 66: return { ok: false, reason: 'failed', message: `${what} : écriture impossible dans /etc/systemd/system ; rien n’a été modifié.` };
    case 67: return { ok: false, reason: 'unavailable', message: 'systemctl introuvable (/usr/bin/systemctl) : rien n’a été modifié.' };
    case 68: return { ok: false, reason: 'failed', message: `${what} : fichiers ${mode === 'install' ? 'écrits' : 'retirés'}, mais « systemctl daemon-reload » a échoué ; il s’appliquera au prochain démarrage.` };
    case 69: return { ok: false, reason: 'failed', message: 'Écriture interrompue : les fichiers de l’app ont été retirés, aucune protection système.' };
    default: {
      const l = lastLine(stderr);
      return { ok: false, reason: 'failed', message: `Échec (code ${code})${l ? ` : ${l}` : ''}.` };
    }
  }
}

export type DeskRootRun = (cmd: string, args: string[], o: { timeout: number }) => Promise<{ code: number; stderr: string }>;
/** Saisie du mot de passe comprise. */
const ROOT_TIMEOUT_MS = 120_000;

export async function runDeskRoot(mode: DeskRootMode, mb: number | null, run: DeskRootRun): Promise<DeskRootResult> {
  let argv: string[];
  try {
    argv = deskRootArgv(mode, mb);
  } catch (e) {
    return { ok: false, reason: 'invalid', message: `${(e as Error).message} : rien n’a été modifié.` };
  }
  try {
    const r = await run(PKEXEC, argv, { timeout: ROOT_TIMEOUT_MS });
    return deskRootExitMessage(r.code, mode, r.stderr);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: false, reason: 'unavailable', message: 'pkexec indisponible : rien n’a été modifié.' };
    return { ok: false, reason: 'failed', message: `Échec : ${(e as Error)?.message ?? String(e)}` };
  }
}

const readText = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};
/** memory.low : octets ; « max » → Infinity ; illisible → null. */
const lowOf = (t: string | null): number | null => {
  const s = t?.trim();
  if (s === 'max') return Infinity;
  return s !== undefined && /^\d{1,20}$/.test(s) ? Number(s) : null;
};

/** Option memory_recursiveprot du montage cgroup2 de /sys/fs/cgroup (contenu de /proc/mounts). */
export function hasRecursiveProt(mounts: string | null): boolean {
  return (mounts ?? '').split('\n').some((l) => {
    const f = l.split(' ');
    return f[1] === '/sys/fs/cgroup' && f[2] === 'cgroup2' && (f[3] ?? '').split(',').includes('memory_recursiveprot');
  });
}

/** État lu (lecture seule) : nos trois fichiers, memory.low des trois niveaux système, option de montage. */
export function readDeskRootStatus(i: { etc?: string; cgroupRoot?: string; uid: number; targetMB: number | null; mounts: string | null; read?: (p: string) => string | null }): DeskRootStatus {
  const read = i.read ?? readText;
  const etc = i.etc ?? DESK_ROOT_ETC;
  const root = i.cgroupRoot ?? '/sys/fs/cgroup';
  return deskRootStatus({
    files: DESK_ROOT_DROPINS.map((d) => read(join(etc, d.dir, DESK_ROOT_NAME))),
    lows: deskRootLevels(i.uid).map((l) => lowOf(read(`${root}${l.cgroup}/memory.low`))),
    targetMB: i.targetMB, uid: i.uid, recursiveprot: hasRecursiveProt(i.mounts), etc,
  });
}

/** Valeur voulue d'après la réserve du plafond de travail (réglée ou automatique) et la RAM ; null : inconnue. */
export function deskRootTargetFrom(reserveMB: number | null, memTotalKB: number): number | null {
  return deskRootTargetMB(sliceLimits(memTotalKB, 0, reserveMB)?.reserveBytes ?? null, memTotalKB * 1024);
}

/** Texte de la confirmation native : fichiers et contenu exacts, commande lancée. */
export function deskRootConfirmation(mode: DeskRootMode, st: DeskRootStatus): { message: string; detail: string; confirm: string } {
  if (mode === 'remove') {
    return {
      message: 'Retirer la protection mémoire système du bureau ?',
      detail: [
        `Fichiers supprimés (et leurs dossiers s’ils sont vides) :\n${st.paths.join('\n')}`,
        `Puis : systemctl daemon-reload (memory.low revient à 0 sur ${st.levels.map((l) => l.unit).join(', ')}).`,
        `Commande : pkexec /usr/bin/bash -c … ${DESK_ROOT_ARGV0} remove 0 (script figé de l’app).`,
        'Le mot de passe administrateur est demandé une seule fois.',
      ].join('\n\n'),
      confirm: 'Retirer',
    };
  }
  const mb = st.targetMB!;
  return {
    message: st.files === 'absent' ? 'Activer la protection mémoire du bureau au niveau système ?' : 'Mettre à jour la protection mémoire système du bureau ?',
    detail: [
      `MemoryLow=${mb}M (réserve du bureau) sur ${st.levels.map((l) => l.unit).join(', ')} : sans elle, la protection posée dans la session est sans effet.`,
      ...DESK_ROOT_DROPINS.map((d, k) => `${st.paths[k]} :\n${deskRootContent(d.section, mb).trimEnd()}`),
      'Puis : systemctl daemon-reload (appliqué tout de suite, sans redémarrer la session).',
      `Commande : pkexec /usr/bin/bash -c … ${DESK_ROOT_ARGV0} install ${mb} (script figé de l’app).`,
      'Réversible : « Retirer » dans Réglages › Plafond de travail. Le mot de passe administrateur est demandé une seule fois.',
    ].join('\n\n'),
    confirm: st.files === 'absent' ? 'Activer' : 'Mettre à jour',
  };
}

/**
 * Gestionnaire de `deskRoot:apply` : le renderer ne fournit qu'un mot-clé. Le main relit l'état (valeur voulue comprise),
 * vérifie qu'il y a quelque chose à faire, demande confirmation, relit (rien de changé entre-temps), lance un seul pkexec,
 * puis relit encore pour dire si l'effet est là (memory.low > 0 aux trois niveaux). Un seul à la fois.
 */
export function createDeskRootAction(deps: {
  status: () => Promise<DeskRootStatus>;
  confirm: (c: { message: string; detail: string; confirm: string }) => Promise<boolean>;
  run: DeskRootRun;
  log?: (msg: string) => void;
}): (raw: unknown) => Promise<DeskRootResult> {
  let held = false;
  const key = (s: DeskRootStatus) => `${s.files}|${s.installedMB}|${s.targetMB}`;
  return async (raw) => {
    if (!isMode(raw)) return { ok: false, reason: 'invalid', message: 'Demande invalide : rien n’a été modifié.' };
    if (held) return { ok: false, reason: 'failed', message: 'Une opération est déjà en cours.' };
    held = true;
    try {
      const st = await deps.status();
      if (raw === 'install') {
        if (st.targetMB === null) return { ok: false, reason: 'unavailable', message: 'Réserve du bureau inconnue (RAM illisible ou réserve trop grande) : rien n’a été modifié.', status: st };
        if (st.files === 'installed') return { ok: false, reason: 'stale', message: 'Déjà en place : rien à faire.', status: st };
      } else if (st.files === 'absent') return { ok: false, reason: 'stale', message: 'Rien à retirer.', status: st };
      if (!(await deps.confirm(deskRootConfirmation(raw, st)))) return { ok: false, reason: 'cancelled', message: 'Annulé : rien n’a été modifié.', status: st };
      const again = await deps.status();
      if (key(again) !== key(st)) return { ok: false, reason: 'stale', message: 'L’état a changé pendant la confirmation : rien n’a été modifié.', status: again };
      const r = await runDeskRoot(raw, raw === 'install' ? st.targetMB : null, deps.run);
      deps.log?.(`protection mémoire système (${raw}${raw === 'install' ? ` ${st.targetMB} Mo` : ''}) : ${r.ok ? 'ok' : r.message}`);
      const after = await deps.status();
      if (!r.ok) return { ...r, status: after };
      if (raw === 'remove') return { ok: true, message: 'Protection mémoire système retirée.', status: after };
      const zero = after.levels.filter((l) => !(l.low !== null && l.low > 0)).map((l) => l.unit);
      return {
        ok: true,
        status: after,
        message: after.effective
          ? `Protection mémoire système active (${st.targetMB} Mo sur ${after.levels.map((l) => l.unit).join(', ')}) ; le bureau prioritaire la prend en compte sous 5 min.`
          : `Fichiers posés, mais memory.low reste à 0 sur ${zero.join(', ')} : se déconnecter puis se reconnecter, puis revérifier.`,
      };
    } finally {
      held = false;
    }
  };
}

/**
 * Bout en bout et développement : `PROC_WATCH_DESK_ROOT_FAKE=<dossier absolu>` hors paquet. /etc/systemd/system est remplacé
 * par <dossier>/etc, systemctl par <dossier>/systemctl et /sys/fs/cgroup par <dossier>/cgroup ; le VRAI script est lancé
 * par /usr/bin/bash, sans pkexec. Une app empaquetée l'ignore toujours ; jamais sous /etc, /usr, /sys ni /proc.
 */
export function deskRootFake(env: NodeJS.ProcessEnv, isPackaged: boolean): { dir: string; etc: string; cgroupRoot: string; run: DeskRootRun } | null {
  const raw = env.PROC_WATCH_DESK_ROOT_FAKE;
  if (isPackaged || !raw || !isAbsolute(raw)) return null;
  let dir: string;
  try {
    dir = realpathSync(raw);
    if (!statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  if (['/etc', '/usr', '/sys', '/proc'].some((p) => dir === p || dir.startsWith(`${p}/`)) || !PATH_RE.test(dir)) return null;
  const etc = join(dir, 'etc');
  const script = deskRootScript({ etc, systemctl: join(dir, 'systemctl') });
  const run: DeskRootRun = (cmd, args, o) => {
    // même argv que pkexec, script réel remplacé par sa version aux chemins simulés ; pkexec lui-même jamais lancé
    if (cmd !== PKEXEC || args[0] !== '/usr/bin/bash' || args[1] !== '-c') return Promise.resolve({ code: 64, stderr: 'argv refusé' });
    const argv = ['-c', script, ...args.slice(3)];
    return new Promise((resolve) => {
      execFile('/usr/bin/bash', argv, { timeout: o.timeout, encoding: 'utf8', env: cleanEnv(process.env) }, (err, _out, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0;
        resolve({ code, stderr: String(stderr) });
      });
    });
  };
  return { dir, etc, cgroupRoot: join(dir, 'cgroup'), run };
}

/** Lanceur réel (pkexec). */
export const realDeskRootRun: DeskRootRun = (cmd, args, o) => defaultRun(cmd, args, o);
