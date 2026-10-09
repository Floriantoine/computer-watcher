// Instance unique, avec la course de la relance après mise à jour : electron-updater lance la nouvelle AppImage
// (APPIMAGE_SILENT_INSTALL=true) juste avant que l'ancienne ne quitte ; sans nouvel essai, la nouvelle perdrait le verrou
// et s'arrêterait, et plus aucune fenêtre ne serait ouverte.

const ATTEMPTS = 20;
const DELAY_MS = 250;

/**
 * Relance (APPIMAGE_SILENT_INSTALL=true d'electron-updater, ou PROC_WATCH_RELAUNCH=1 de proc-watch : relance après
 * installation ou mise à jour) : nouveaux essais le temps que l'instance précédente quitte. Verrou obtenu : ces deux
 * variables sont retirées de l'environnement (jamais transmises aux processus lancés ensuite).
 */
export function acquireLock(o: { tryLock: () => boolean; env: NodeJS.ProcessEnv; sleep: (ms: number) => void }): boolean {
  const got = () => {
    delete o.env.APPIMAGE_SILENT_INSTALL;
    delete o.env.PROC_WATCH_RELAUNCH;
    return true;
  };
  if (o.tryLock()) return got();
  if (o.env.APPIMAGE_SILENT_INSTALL !== 'true' && o.env.PROC_WATCH_RELAUNCH !== '1') return false;
  for (let i = 0; i < ATTEMPTS; i++) {
    o.sleep(DELAY_MS);
    if (o.tryLock()) return got();
  }
  return false;
}

/** Attente bloquante (avant `ready`, rien d'autre ne tourne encore dans le main). */
export const blockingSleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
