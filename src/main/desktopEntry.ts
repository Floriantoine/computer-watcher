import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { hasControlChars } from './appImageTrust';

/** Clé posée dans les raccourcis écrits par proc-watch : seuls ceux-là sont repointés après une mise à jour. */
export const MANAGED_KEY = 'X-ProcWatch-Managed=1';

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
    MANAGED_KEY,
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
  if (hasControlChars(target)) throw new Error('Chemin refusé (caractère de contrôle)');
  const dir = entryDir(env, home);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'proc-watch.desktop');
  writeFileSync(file, desktopEntryContent(target));
  return file;
}

/**
 * Après une mise à jour de l'AppImage sous un nouveau nom (electron-updater supprime l'ancienne et place la nouvelle dans le
 * même dossier) : le raccourci écrit par proc-watch (clé X-ProcWatch-Managed) est repointé sur `appImage`, seulement si
 * son ancienne cible n'existe plus et que `appImage` est dans le même dossier. Lancer une autre copie ne le détourne jamais.
 */
export function refreshDesktopEntry(
  appImage: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): 'absent' | 'unchanged' | 'updated' | 'kept' | 'foreign' | 'refused' {
  if (hasControlChars(appImage)) return 'refused';
  const file = join(entryDir(env, home), 'proc-watch.desktop');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return 'absent';
  }
  const want = desktopEntryContent(appImage);
  if (text === want) return 'unchanged';
  if (!text.split('\n').includes(MANAGED_KEY)) return 'foreign';
  const exec = /^Exec="(.*)"$/m.exec(text);
  if (!exec) return 'foreign';
  const old = exec[1].replace(/%%/g, '%').replace(/\\(.)/g, '$1');
  if (existsSync(old) || dirname(old) !== dirname(appImage)) return 'kept';
  writeFileSync(file, want);
  return 'updated';
}
