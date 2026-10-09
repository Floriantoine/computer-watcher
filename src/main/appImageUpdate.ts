// Backend AppImage : electron-updater (AppImageUpdater seulement, jamais DebUpdater qui installerait via pkexec).
// Chargé à la demande : une version lancée depuis les sources ou un .deb ne charge jamais electron-updater.
import { writeFileSync } from 'node:fs';
import { REPO_RELEASES_URL } from '../core/update';
import type { UpdateBackend } from './updater';

export interface AppImageBackendOptions {
  /** Flux de test local (generic) ; null : flux GitHub de app-update.yml (écrit par electron-builder, https). */
  testFeed: string | null;
  /** Mode test (non empaqueté) : fichier de config d'electron-updater écrit ici (nom du dossier de cache). */
  testConfigPath: string;
}

export async function createAppImageBackend(o: AppImageBackendOptions): Promise<UpdateBackend> {
  const { AppImageUpdater } = await import('electron-updater');
  const u = new AppImageUpdater();
  u.autoDownload = false; // jamais de téléchargement silencieux
  u.autoInstallOnAppQuit = false; // installation seulement par « Redémarrer et installer »
  u.allowDowngrade = false;
  u.fullChangelog = false;
  u.logger = { info: () => {}, debug: () => {}, warn: (m: unknown) => console.warn('updater:', m), error: (m: unknown) => console.error('updater:', m) };
  if (o.testFeed) {
    writeFileSync(o.testConfigPath, 'updaterCacheDirName: proc-watch-updater-test\n');
    u.updateConfigPath = o.testConfigPath;
    u.forceDevUpdateConfig = true;
    u.setFeedURL({ provider: 'generic', url: o.testFeed });
  }
  return {
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
        await u.downloadUpdate();
      } finally {
        u.removeListener('download-progress', listener);
      }
    },
    install() {
      // Remplace l'AppImage (même dossier), puis relance la nouvelle version ; l'app quitte juste après.
      u.quitAndInstall(false, true);
    },
  };
}
