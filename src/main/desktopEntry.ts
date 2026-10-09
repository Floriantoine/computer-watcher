import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function escapeExec(p: string): string {
  return p.replace(/[\\"`$]/g, '\\$&').replace(/%/g, '%%');
}

export function desktopEntryContent(execPath: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=proc-watch',
    'Comment=Voir et tuer les processus gourmands',
    `Exec="${escapeExec(execPath)}"`,
    'Icon=proc-watch',
    'Terminal=false',
    'Categories=System;Monitor;',
    '',
  ].join('\n');
}

/**
 * Écrit l'entrée de menu et copie l'icône de l'app dans le thème hicolor de l'utilisateur (`Icon=proc-watch`).
 * Une icône introuvable n'empêche pas l'entrée : le bureau affichera son icône par défaut.
 */
export function installDesktopEntry(target: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir(), iconPng?: string): string {
  const data = env.XDG_DATA_HOME || join(home, '.local/share');
  if (iconPng) {
    try {
      const iconDir = join(data, 'icons/hicolor/512x512/apps');
      mkdirSync(iconDir, { recursive: true });
      copyFileSync(iconPng, join(iconDir, 'proc-watch.png'));
    } catch {
      // icône facultative
    }
  }
  const dir = join(data, 'applications');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'proc-watch.desktop');
  writeFileSync(file, desktopEntryContent(target));
  return file;
}
