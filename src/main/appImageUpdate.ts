// Backend AppImage : electron-updater (AppImageUpdater seulement, jamais DebUpdater qui installerait via pkexec).
// Chargé à la demande : une version lancée depuis les sources ou un .deb ne charge jamais electron-updater.
import { existsSync, writeFileSync } from 'node:fs';
import { REPO_RELEASES_URL } from '../core/update';
import { InstallError, type UpdateBackend } from './updater';

export interface AppImageBackendOptions {
  /** Flux de test local (generic) ; null : flux GitHub de app-update.yml (écrit par electron-builder, https). */
  testFeed: string | null;
  /** Mode test (non empaqueté) : fichier de config d'electron-updater écrit ici (nom du dossier de cache). */
  testConfigPath: string;
  /** AppImage vérifiée de ce processus (realAppImage), remplacée par electron-updater. */
  appImage: string;
}

/**
 * Fichier qu'electron-updater va remplacer : il lit process.env.APPIMAGE (posé par le runtime AppImage : la copie installée
 * quand l'app tourne depuis elle) et, le nom « proc-watch.AppImage » n'ayant pas de version, l'écrase sur place. On exige
 * que ce soit exactement l'AppImage vérifiée par realAppImage() ; sinon (variable modifiée depuis) : refusé.
 */
export function installTarget(env: NodeJS.ProcessEnv, verified: string): string {
  if (env.APPIMAGE !== verified) throw new Error(`Installation refusée : APPIMAGE (${env.APPIMAGE ?? 'absent'}) n’est pas l’AppImage vérifiée (${verified})`);
  return verified;
}

export async function createAppImageBackend(o: AppImageBackendOptions): Promise<UpdateBackend> {
  const { AppImageUpdater } = await import('electron-updater');
  const u = new AppImageUpdater();
  u.autoDownload = false; // jamais de téléchargement silencieux
  u.autoInstallOnAppQuit = false; // installation seulement par « Redémarrer et installer »
  u.allowDowngrade = false;
  u.fullChangelog = false;
  // Erreur sans écouteur : EventEmitter relancerait l'exception. Gardée pour l'installation (voir install()).
  let lastError: Error | null = null;
  u.on('error', (e: Error) => {
    lastError = e;
  });
  u.logger = { info: () => {}, debug: () => {}, warn: (m: unknown) => console.warn('updater:', m), error: (m: unknown) => console.error('updater:', m) };
  if (o.testFeed) {
    writeFileSync(o.testConfigPath, 'updaterCacheDirName: proc-watch-updater-test\n');
    u.updateConfigPath = o.testConfigPath;
    u.forceDevUpdateConfig = true;
    u.setFeedURL({ provider: 'generic', url: o.testFeed });
  }
  /** Fichier téléchargé et vérifié (sha512), dans pending/ du cache d'electron-updater. */
  let downloaded: string | null = null;
  const pendingFile = () => (downloaded && existsSync(downloaded) ? downloaded : null);
  return {
    pendingFile,
    async check(allowPrerelease) {
      u.allowPrerelease = allowPrerelease;
      const r = await u.checkForUpdates();
      if (!r || !r.isUpdateAvailable) return null;
      const version = r.updateInfo.version;
      return { version, notes: r.updateInfo.releaseNotes, url: `${REPO_RELEASES_URL}/tag/v${version}` };
    },
    async download(onProgress) {
      const listener = (p: { percent: number }) => onProgress(p.percent);
      u.on('download-progress', listener);
      try {
        // Rejeté si le sha512 du fichier téléchargé ne correspond pas à latest-linux.yml.
        const paths = await u.downloadUpdate();
        downloaded = paths.find((p) => p.endsWith('.AppImage')) ?? paths[0] ?? null;
      } finally {
        u.removeListener('download-progress', listener);
      }
    },
    install() {
      // Remplace l'AppImage (même dossier), puis relance la nouvelle version ; l'app quitte juste après. L'installation
      // est synchrone : un échec (dossier en lecture seule…) est signalé par l'événement `error`, renvoyé ici en exception.
      // electron-updater supprime l'ancienne AppImage avant de déplacer la nouvelle : après un premier échec, elle peut
      // manquer et sa suppression échouerait à nouveau. Un fichier vide à sa place permet de réessayer le même chemin.
      installTarget(process.env, o.appImage);
      const file = pendingFile();
      if (file && !existsSync(o.appImage)) {
        try {
          writeFileSync(o.appImage, '', { flag: 'wx' });
        } catch {
          // dossier en lecture seule : l'échec est signalé ci-dessous, avec la commande de secours
        }
      }
      lastError = null;
      u.quitAndInstall(false, true);
      const failed = lastError as Error | null;
      if (failed) throw new InstallError(failed.message, pendingFile(), o.appImage);
    },
  };
}
