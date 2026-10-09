import { homedir } from 'node:os';
import { configDir } from '../core/config';

/**
 * Dossier `userData` d'Electron (profil Chromium, verrou d'instance unique) : le dossier de config de l'app, fixé au
 * démarrage avant `ready` pour ne jamais dépendre de `productName` ni du nom affiché. Même règle que configDir : le
 * nouveau (computer-watcher) s'il existe ou si rien d'ancien n'existe, sinon l'ancien (migration pas faite ou échouée).
 */
export function userDataPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return configDir(env, home);
}
