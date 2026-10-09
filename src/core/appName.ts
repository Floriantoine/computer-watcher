/** Noms de l'app : affiché, technique (dossiers, service, fichiers), ancien (migration et compatibilité). */
export const APP_NAME = 'computer-watcher';
export const APP_DISPLAY_NAME = 'Computer Watcher';
/** Ancien nom technique (jusqu'à la v0.1.x) : reconnu pour la migration et la compatibilité, jamais créé. */
export const LEGACY_APP_NAME = 'proc-watch';
/** `comm` du processus : le noyau tronque à 15 caractères. */
export const APP_COMM = APP_NAME.slice(0, 15);
/** Noms de processus sous lesquels l'app (ou son ancienne version) tourne. */
export const APP_SELF_NAMES: readonly string[] = [APP_NAME, APP_COMM, LEGACY_APP_NAME];
