// src/recorder/launchApp.ts — bouton « Ouvrir » d'une notification : lance (ou réveille) l'app sur une alerte.
//
// Comment le service trouve l'app : il en est lui-même une partie.
//  - AppImage : le runtime définit APPIMAGE → on relance ce fichier.
//  - Paquet (.deb, dossier dézippé) : le script est dans `…/resources/app.asar` → le binaire empaqueté (process.execPath).
//  - Clone lancé par `electron-vite preview` (ex. .worktrees/stable) : le service exécute `<electron> <racine>/out/main/recorder.js`
//    → on lance `<electron> <racine>` (même sortie construite que preview), si `<racine>/out/main/index.js` existe.
// Introuvable, ou service exécuté en root : pas de lanceur, la notification part sans bouton.
// L'app s'exécute toujours sous l'utilisateur du service (jamais sudo/pkexec/runuser) ; son verrou d'instance unique
// fait qu'une app déjà ouverte reçoit `--alert=<id>` et se montre au lieu de démarrer une seconde fois.
import { spawn as nodeSpawn } from 'node:child_process';
import { dirname, resolve, sep } from 'node:path';

export interface Launcher { cmd: string; args: string[] }

export function appLauncher(p: { appImage?: string; execPath: string; recorderScript: string | undefined; uid: number; exists: (path: string) => boolean }): Launcher | null {
  if (p.uid === 0) return null;
  if (p.appImage) return p.exists(p.appImage) ? { cmd: p.appImage, args: [] } : null;
  if (!p.recorderScript) return null;
  const root = resolve(dirname(p.recorderScript), '../..');
  if (!p.exists(p.execPath)) return null;
  if (root.endsWith('.asar') || root.includes(`.asar${sep}`)) return { cmd: p.execPath, args: [] };
  return p.exists(resolve(root, 'out/main/index.js')) ? { cmd: p.execPath, args: [root] } : null;
}

/**
 * Avec systemd-run : unité transitoire du gestionnaire de l'utilisateur, hors du cgroup du service (un redémarrage du
 * service ne tue pas l'app) et sans hériter de sa priorité basse (Nice=10). Sinon lancement direct détaché.
 */
export function appLaunchCommand(l: Launcher, extra: string[], systemdRun: string | null): Launcher {
  if (systemdRun) return { cmd: systemdRun, args: ['--user', '--collect', '--quiet', '--', l.cmd, ...l.args, ...extra] };
  return { cmd: l.cmd, args: [...l.args, ...extra] };
}

export function launchApp(c: Launcher, deps: { spawn?: typeof nodeSpawn; env?: NodeJS.ProcessEnv; log?: (m: string) => void } = {}): void {
  const spawn = deps.spawn ?? nodeSpawn;
  const log = deps.log ?? ((m: string) => console.error(m));
  // le service tourne avec ELECTRON_RUN_AS_NODE=1 : l'app lancée directement doit démarrer en Electron
  const { ELECTRON_RUN_AS_NODE: _drop, ...env } = deps.env ?? process.env;
  try {
    const child = spawn(c.cmd, c.args, { detached: true, stdio: 'ignore', env });
    child.on('error', (e: Error) => log(`lancement de l'app : ${e.message}`));
    child.unref();
  } catch (e) {
    log(`lancement de l'app : ${(e as Error).message}`);
  }
}
