import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { appDir } from './appDirs';
import { APP_NAME } from './appName';

/** Dossier de base XDG : la variable seulement si elle est un chemin absolu (spécification XDG), sinon `fallback`. */
export function xdgHome(env: NodeJS.ProcessEnv, key: 'XDG_CONFIG_HOME' | 'XDG_DATA_HOME' | 'XDG_CACHE_HOME', fallback: string): string {
  const v = env[key];
  return v && isAbsolute(v) ? v : fallback;
}

export type XdgFamily = 'default' | 'explicit';
const famOf = (env: NodeJS.ProcessEnv, key: 'XDG_CONFIG_HOME' | 'XDG_DATA_HOME' | 'XDG_CACHE_HOME'): XdgFamily => {
  const v = env[key];
  return v && isAbsolute(v) ? 'explicit' : 'default';
};

/**
 * Famille de chaque racine XDG (par défaut sous HOME, ou définie en chemin absolu). Cohérentes : toutes par défaut (vraie
 * installation) ou toutes définies (app d'essai complète). Sinon « XDG partiel » : une app d'essai à config temporaire
 * verrait les vrais dossiers de données ou de cache ; la migration et la désinstallation ne touchent jamais une racine
 * d'une autre famille. XDG_RUNTIME_DIR n'en fait pas partie (rien n'y est jamais déplacé ni retiré).
 */
export function xdgFamilies(env: NodeJS.ProcessEnv): { config: XdgFamily; data: XdgFamily; cache: XdgFamily; consistent: boolean } {
  const config = famOf(env, 'XDG_CONFIG_HOME');
  const data = famOf(env, 'XDG_DATA_HOME');
  const cache = famOf(env, 'XDG_CACHE_HOME');
  return { config, data, cache, consistent: config === data && data === cache };
}

export function dataDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return appDir(xdgHome(env, 'XDG_DATA_HOME', join(home, '.local/share')));
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
 * service avant une notification du bureau : dans $XDG_RUNTIME_DIR/computer-watcher/focus-<empreinte du dossier de données>.json
 * (tmpfs de session, 0700, vidé à la déconnexion),
 * sinon dans le dossier de données.
 */
export function focusStatePath(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const run = env.XDG_RUNTIME_DIR;
  if (!run || !isAbsolute(run)) return join(dataDir, 'app-focus.json');
  // un fichier par dossier de données : une app de test ou de mesure (dossiers temporaires) ne touche jamais celui de l'utilisateur
  const id = createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 12);
  return join(run, APP_NAME, `focus-${id}.json`);
}
