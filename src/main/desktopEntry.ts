import { homedir } from 'node:os';
import { join } from 'node:path';
import { copyFileAtomic, writeFileAtomic } from './atomicFile';

/**
 * Argument de Exec entre guillemets, selon la spécification Desktop Entry : d'abord la règle des guillemets (`"`, `` ` ``,
 * `$`, `\` précédés de `\`), puis la règle des chaînes (`\` → `\\`, sauts de ligne → `\n`…), enfin `%` → `%%`.
 * Un `\` littéral s'écrit donc `\\\\` et un `$` `\\$`. Les autres caractères de contrôle sont refusés.
 */
export function quoteExecArg(arg: string): string {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(arg)) throw new Error('Chemin invalide (caractère de contrôle)');
  const quoted = arg.replace(/[\\"`$]/g, '\\$&');
  const str = quoted.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r');
  return `"${str.replace(/%/g, '%%')}"`;
}

/** Marque des entrées écrites par proc-watch (menu, démarrage automatique) : seules celles-ci sont repointées ou retirées. */
export const MANAGED_LINE = 'X-ProcWatch-Managed=1';
export const isManagedEntry = (text: string): boolean => text.split('\n').some((l) => l.trim() === MANAGED_LINE);

const SAFE_ARG = /^[A-Za-z0-9_\-=./]+$/;

export interface EntryOptions {
  /** Arguments après le chemin (ex. `--hidden`). */
  args?: string[];
  /** Entrée de ~/.config/autostart : pas de catégorie de menu. */
  autostart?: boolean;
}

export function desktopEntryContent(execPath: string, o: EntryOptions = {}): string {
  const exec = [quoteExecArg(execPath), ...(o.args ?? []).map((a) => (SAFE_ARG.test(a) ? a : quoteExecArg(a)))].join(' ');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=proc-watch',
    'Comment=Voir et tuer les processus gourmands',
    `Exec=${exec}`,
    'Icon=proc-watch',
    'Terminal=false',
    MANAGED_LINE,
    ...(o.autostart ? ['X-GNOME-Autostart-enabled=true'] : ['Categories=System;Monitor;']),
    '',
  ].join('\n');
}

/**
 * Écrit l'entrée de menu et copie l'icône de l'app dans le thème hicolor de l'utilisateur (`Icon=proc-watch`).
 * Une icône introuvable n'empêche pas l'entrée : le bureau affichera son icône par défaut.
 * Écritures atomiques : un lien symbolique posé à l'un de ces chemins est remplacé, jamais suivi.
 */
export function installDesktopEntry(target: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir(), iconPng?: string): string {
  const data = env.XDG_DATA_HOME || join(home, '.local/share');
  const content = desktopEntryContent(target);
  if (iconPng) {
    try {
      copyFileAtomic(iconPng, join(data, 'icons/hicolor/512x512/apps/proc-watch.png'));
    } catch {
      // icône facultative
    }
  }
  const file = join(data, 'applications', 'proc-watch.desktop');
  writeFileAtomic(file, content);
  return file;
}
