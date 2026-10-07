import { homedir } from 'node:os';
import { join } from 'node:path';

export function dataDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(env.XDG_DATA_HOME || join(home, '.local/share'), 'proc-watch');
}
export const dbPath = (dir: string) => join(dir, 'metrics.db');
export const statusPath = (dir: string) => join(dir, 'recorder-status.json');
export const appEventsPath = (dir: string) => join(dir, 'app-events.jsonl');
export const clearRequestPath = (dir: string) => join(dir, 'clear-request');
