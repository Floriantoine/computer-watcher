import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function desktopEntryContent(execPath: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=proc-watch',
    'Comment=Voir et tuer les processus gourmands',
    `Exec="${execPath}"`,
    'Icon=utilities-system-monitor',
    'Terminal=false',
    'Categories=System;Monitor;',
    '',
  ].join('\n');
}

export function installDesktopEntry(target: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const dir = join(env.XDG_DATA_HOME || join(home, '.local/share'), 'applications');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'proc-watch.desktop');
  writeFileSync(file, desktopEntryContent(target));
  return file;
}
