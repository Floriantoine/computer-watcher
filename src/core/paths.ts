import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export function dataDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(env.XDG_DATA_HOME || join(home, '.local/share'), 'proc-watch');
}
export const dbPath = (dir: string) => join(dir, 'metrics.db');
export const statusPath = (dir: string) => join(dir, 'recorder-status.json');
export const appEventsPath = (dir: string) => join(dir, 'app-events.jsonl');
export const clearRequestPath = (dir: string) => join(dir, 'clear-request');
/**
 * État de la fenêtre de l'app (focus + horodatage), écrit par le main toutes les 4 s tant qu'elle a le focus, lu par le
 * service avant une notification du bureau : dans $XDG_RUNTIME_DIR (tmpfs de session, 0700, vidé à la déconnexion),
 * sinon dans le dossier de données.
 */
export function focusStatePath(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const run = env.XDG_RUNTIME_DIR;
  return run && isAbsolute(run) ? join(run, 'proc-watch', 'app-focus.json') : join(dataDir, 'app-focus.json');
}
