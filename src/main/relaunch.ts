// Relance détachée de l’app (copie installée après « Installer comme une app », version mise à jour) et
// environnement du processus principal en mode AppImage.
import { cleanEnv } from '../core/childEnv';

/** Variables de liste de l'AppRun d'electron-builder, préfixées par le montage /tmp de l'AppImage. */
const APPRUN_LISTS = ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR'];

/**
 * n-2 : en mode AppImage, au démarrage, ces variables de `process.env` sont remplacées par leur version cleanEnv (sans
 * le montage) : tout processus lancé ensuite, même par Electron (xdg-open de shell.openExternal…) et qui survivrait à
 * l'app, n'hérite de rien sous /tmp/.mount_*. APPIMAGE et APPDIR, de simples chaînes lues par l'app, sont gardés.
 */
export function sanitizeAppImageEnv(env: NodeJS.ProcessEnv): void {
  const clean = cleanEnv(env);
  for (const k of APPRUN_LISTS) {
    if (clean[k] === undefined) delete env[k];
    else env[k] = clean[k];
  }
}

/**
 * Relance de l’app : environnement sans le montage /tmp qui va disparaître (I-C), et PROC_WATCH_RELAUNCH=1 pour que
 * la nouvelle instance réessaie de prendre le verrou si l'ancienne ne l'a pas encore rendu (n-3).
 */
export function restartCommand(target: string, env: NodeJS.ProcessEnv): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  return { cmd: target, args: [], env: { ...cleanEnv(env), PROC_WATCH_RELAUNCH: '1' } };
}

interface ChildLike {
  once(ev: 'spawn', cb: () => void): unknown;
  once(ev: 'error', cb: (e: Error) => void): unknown;
  unref(): void;
}

export interface RelaunchDeps {
  target: string;
  env: NodeJS.ProcessEnv;
  /** La cible est-elle une AppImage utilisable (isUsableAppImage) ? Vérifié juste avant le spawn. */
  usable: (path: string) => boolean;
  spawn: (cmd: string, args: string[], opts: { detached: true; stdio: 'ignore'; env: NodeJS.ProcessEnv }) => ChildLike;
  releaseLock: () => void;
  reacquireLock: () => boolean;
  /** La nouvelle instance a démarré : quitter. */
  onStarted: () => void;
  /** Rien n'a démarré : l'app reste ouverte (verrou repris), message avec le chemin. */
  onFailed: (message: string) => void;
}

/**
 * n-1 : on ne quitte qu'à l'événement « spawn » (exec réussi). « error » (EACCES, ENOENT…) ou exception : le verrou
 * d'instance unique est repris et l'échec signalé ; l'app reste ouverte. Cible inutilisable : rien n'est lancé.
 */
export function relaunchDetached(d: RelaunchDeps): void {
  if (!d.usable(d.target)) {
    d.onFailed(`${d.target} : pas une AppImage utilisable`);
    return;
  }
  d.releaseLock(); // la nouvelle instance prend le verrou
  const c = restartCommand(d.target, d.env);
  const fail = (e: unknown) => {
    d.reacquireLock();
    d.onFailed(`${d.target} : ${e instanceof Error ? e.message : String(e)}`);
  };
  let child: ChildLike;
  try {
    child = d.spawn(c.cmd, c.args, { detached: true, stdio: 'ignore', env: c.env });
  } catch (e) {
    fail(e);
    return;
  }
  child.once('spawn', () => {
    child.unref();
    d.onStarted();
  });
  child.once('error', fail);
}
