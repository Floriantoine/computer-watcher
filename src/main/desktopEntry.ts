import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

const entryDir = (env: NodeJS.ProcessEnv, home: string) => join(env.XDG_DATA_HOME || join(home, '.local/share'), 'applications');

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
  const dir = entryDir(env, home);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'proc-watch.desktop');
  writeFileSync(file, desktopEntryContent(target));
  return file;
}

/**
 * Après une mise à jour de l'AppImage (nouveau nom de fichier, l'ancien est supprimé par electron-updater) : un raccourci
 * créé par proc-watch pour une AppImage est repointé sur `appImage`. Raccourci absent, modifié à la main ou d'un paquet : rien.
 */
export function refreshDesktopEntry(appImage: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): 'absent' | 'unchanged' | 'updated' | 'foreign' {
  const file = join(entryDir(env, home), 'proc-watch.desktop');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return 'absent';
  }
  const want = desktopEntryContent(appImage);
  if (text === want) return 'unchanged';
  const exec = /^Exec="(.*)"$/m.exec(text);
  // Seulement un fichier identique à ce que proc-watch écrit, à la ligne Exec près, et qui lançait une AppImage.
  if (!exec || !/\.AppImage$/i.test(exec[1]) || text !== desktopEntryContent(exec[1].replace(/\\(.)/g, '$1').replace(/%%/g, '%'))) return 'foreign';
  writeFileSync(file, want);
  return 'updated';
}
