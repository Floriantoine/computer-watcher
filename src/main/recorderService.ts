import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isUsableAppImage } from './realAppImage';
import { cleanEnv, systemBin } from '../core/childEnv';
import { xdgHome } from '../core/paths';
import { dirname, join } from 'node:path';
import { APP_DISPLAY_NAME, APP_NAME, LEGACY_APP_NAME } from '../core/appName';

export const UNIT_NAME = `${APP_NAME}-recorder.service`;
/** Unité d'avant le renommage : arrêtée et retirée par la migration (si c'est la nôtre), et par la désinstallation. */
export const LEGACY_UNIT_NAME = `${LEGACY_APP_NAME}-recorder.service`;

export function systemdQuote(arg: string): string {
  return '"' + arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$') + '"';
}

/**
 * AppImage que lance le service (N1) : la copie installée (~/Applications/computer-watcher.AppImage) dès qu'elle est utilisable
 * (en-tête AppImage, non vide : R2), même si
 * l'app tourne depuis l'original téléchargé, qui peut être supprimé ; sinon l'AppImage lancée (vérifiée par realAppImage) ;
 * null hors AppImage (.deb, sources : binaire lancé).
 */
export function recorderAppImage(own: string | null, copy: string, usable: (p: string) => boolean = isUsableAppImage): string | null {
  if (!own) return null;
  return usable(copy) ? copy : own;
}

export function recorderExecArgs(p: { appImage?: string; execPath: string; appPath: string }): string[] {
  if (p.appImage) return [p.appImage, '-e', "require(process.env.APPDIR + '/resources/app.asar/out/main/recorder.js')"];
  return [p.execPath, join(p.appPath, 'out/main/recorder.js')];
}

/**
 * Protection mémoire du service (Mo) : ≈ 1,7 × son pic observé (RSS + swap, p99 191 Mo sur 15 jours), pour garder en RAM son
 * tas, le binaire et les pages chaudes de la base. Compte dans la protection de session.slice à hauteur de son usage réel.
 */
export const RECORDER_MEMORY_LOW_MB = 320;

export function recorderUnit(args: string[]): string {
  // une fin de ligne dans un chemin injecterait une directive (ExecStartPre=…) : refusé
  if (args.some((a) => /[\x00-\x1f\x7f]/.test(a))) throw new Error('Argument refusé (caractère de contrôle)');
  return [
    '[Unit]',
    `Description=${APP_DISPLAY_NAME} recorder (historique des processus)`,
    // au plus 5 démarrages en 5 min : pas de boucle infinie si le binaire a disparu
    'StartLimitIntervalSec=300',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Environment=ELECTRON_RUN_AS_NODE=1',
    `ExecStart=${args.map(systemdQuote).join(' ')}`,
    // relancé même après un SIGTERM d'earlyoom (sortie « propre ») ; jamais après un arrêt demandé (systemctl stop)
    'Restart=always',
    'RestartSec=5',
    // Le service doit rester réactif pendant un étouffement : c'est lui qui mesure et applique les règles anti-gel.
    // session.slice : la « protection mémoire système » (MemoryLow sur user.slice → user@<uid>.service) la protège, sans
    // la partager avec Warp et Claude comme app.slice ; MemoryLow n'agit que sous cette protection (sinon sans effet).
    'Slice=session.slice',
    `MemoryLow=${RECORDER_MEMORY_LOW_MB}M`,
    // dernier choix d'earlyoom et du tueur du noyau parmi les processus de l'utilisateur : 100 est le plancher (valeur du
    // gestionnaire utilisateur) ; plus bas, systemd l'ignore. systemd-oomd : candidat seulement faute d'autre.
    'OOMScoreAdjust=100',
    'ManagedOOMPreference=avoid',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function unitPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir(), name: string = UNIT_NAME): string {
  return join(xdgHome(env, 'XDG_CONFIG_HOME', join(home, '.config')), 'systemd/user', name);
}

/**
 * Installer/activer le service au démarrage de l'app ? Oui pour une version installée ; pour un clone de dev,
 * seulement avec PROC_WATCH_RECORDER_DEV=1 (pas de service permanent installé en silence). Le réglage
 * « Enregistrer l'historique », action explicite, gère le service dans tous les cas.
 */
/** PROC_WATCH_NO_RECORDER_SYNC=1 : l'app ne crée, ne modifie ni ne retire jamais l'unité (scripts de mesure, tests). */
export function recorderSyncDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PROC_WATCH_NO_RECORDER_SYNC === '1';
}

export function autoManageService(isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return isPackaged || env.PROC_WATCH_RECORDER_DEV === '1';
}

export type Systemctl = (args: string[]) => Promise<{ ok: boolean; stdout: string }>;

export const defaultSystemctl: Systemctl = (args) =>
  new Promise((resolve) => {
    const bin = systemBin('systemctl', existsSync);
    if (!bin) return resolve({ ok: false, stdout: '' });
    // chemin absolu, environnement sans le montage /tmp de l'AppImage (I-A)
    execFile(bin, ['--user', ...args], { timeout: 5000, env: cleanEnv(process.env) }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout) }));
  });

export async function systemctlAvailable(run: Systemctl): Promise<boolean> {
  return (await run(['show-environment'])).ok;
}

export async function ensureRecorderService(o: {
  enabled: boolean;
  args: string[];
  path: string;
  run: Systemctl;
  /** Faux : ne crée jamais l'unité (mode dev) ; une unité existante est mise à jour ou retirée. */
  allowCreate?: boolean;
  /** Unité inchangée mais l'app a changé de version (mise à jour sur place) : relance le service sur le nouveau code. */
  restart?: boolean;
}): Promise<'installed' | 'updated' | 'unchanged' | 'restarted' | 'removed' | 'absent'> {
  const exists = existsSync(o.path);
  if (!o.enabled) {
    if (!exists) return 'absent';
    await o.run(['disable', '--now', UNIT_NAME]);
    rmSync(o.path, { force: true });
    await o.run(['daemon-reload']);
    return 'removed';
  }
  const content = recorderUnit(o.args);
  if (!exists && o.allowCreate === false) return 'absent';
  if (exists && readFileSync(o.path, 'utf8') === content) {
    await o.run(['enable', '--now', UNIT_NAME]);
    if (!o.restart) return 'unchanged';
    await o.run(['restart', UNIT_NAME]);
    return 'restarted';
  }
  mkdirSync(dirname(o.path), { recursive: true });
  writeFileSync(o.path, content);
  await o.run(['daemon-reload']);
  if (!exists) {
    await o.run(['enable', '--now', UNIT_NAME]);
    return 'installed';
  }
  await o.run(['enable', UNIT_NAME]);
  await o.run(['restart', UNIT_NAME]);
  return 'updated';
}
