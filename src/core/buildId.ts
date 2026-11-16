// Empreinte du build : une même valeur pour l'app et le service d'un même `electron-vite build` (define de
// electron.vite.config.ts). Le service l'écrit dans son statut ; l'app relance au démarrage un service d'un autre build.
declare const __CW_BUILD_ID__: string | undefined;

/** null hors electron-vite (Vitest, outils exécutés par Node). */
export const BUILD_ID: string | null = typeof __CW_BUILD_ID__ === 'string' ? __CW_BUILD_ID__ : null;
