// Instance unique, avec la course de la relance après mise à jour : electron-updater lance la nouvelle AppImage
// (APPIMAGE_SILENT_INSTALL=true) juste avant que l'ancienne ne quitte ; sans nouvel essai, la nouvelle perdrait le verrou
// et s'arrêterait, et plus aucune fenêtre ne serait ouverte.

const ATTEMPTS = 20;
const DELAY_MS = 250;

export function acquireLock(o: { tryLock: () => boolean; env: NodeJS.ProcessEnv; sleep: (ms: number) => void }): boolean {
  if (o.tryLock()) return true;
  if (o.env.APPIMAGE_SILENT_INSTALL !== 'true') return false;
  for (let i = 0; i < ATTEMPTS; i++) {
    o.sleep(DELAY_MS);
    if (o.tryLock()) return true;
  }
  return false;
}

/** Attente bloquante (avant `ready`, rien d'autre ne tourne encore dans le main). */
export const blockingSleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
