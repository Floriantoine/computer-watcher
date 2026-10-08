import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

export function dataDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(env.XDG_DATA_HOME || join(home, '.local/share'), 'proc-watch');
}
export const dbPath = (dir: string) => join(dir, 'metrics.db');
export const statusPath = (dir: string) => join(dir, 'recorder-status.json');
export const appEventsPath = (dir: string) => join(dir, 'app-events.jsonl');
export const clearRequestPath = (dir: string) => join(dir, 'clear-request');
/** « Ignorer 30 min » de la prévision (service et app). */
export const forecastSnoozePath = (dir: string) => join(dir, 'forecast-snooze.json');
/** Crédit de Simulation des règles, écrit par le service, lu par le main au passage en Active. */
export const rulesSimulationPath = (dir: string) => join(dir, 'rules-simulation.json');
/**
 * État de la fenêtre de l'app (focus + horodatage), écrit par le main toutes les 4 s tant qu'elle a le focus, lu par le
 * service avant une notification du bureau : dans $XDG_RUNTIME_DIR/proc-watch/focus-<empreinte du dossier de données>.json
 * (tmpfs de session, 0700, vidé à la déconnexion),
 * sinon dans le dossier de données.
 */
export function focusStatePath(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const run = env.XDG_RUNTIME_DIR;
  if (!run || !isAbsolute(run)) return join(dataDir, 'app-focus.json');
  // un fichier par dossier de données : une app de test ou de mesure (dossiers temporaires) ne touche jamais celui de l'utilisateur
  const id = createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 12);
  return join(run, 'proc-watch', `focus-${id}.json`);
}
