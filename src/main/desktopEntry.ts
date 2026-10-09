import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { hasControlChars } from './appImageTrust';
import { xdgHome } from '../core/paths';
import { readFileSafe, writeFileSafe } from './safeFs';
import { APP_DISPLAY_NAME, APP_NAME } from '../core/appName';

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

/** Marque des entrées écrites par l'app (menu, démarrage automatique ; nom interne inchangé depuis proc-watch) : seules celles-ci sont repointées ou retirées. */
export const MANAGED_LINE = 'X-ProcWatch-Managed=1';
/** Nom gardé pour le code des mises à jour. */
export const MANAGED_KEY = MANAGED_LINE;
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
    `Name=${APP_DISPLAY_NAME}`,
    'Comment=Voir et tuer les processus gourmands',
    `Exec=${exec}`,
    `Icon=${APP_NAME}`,
    `StartupWMClass=${APP_NAME}`,
    'Terminal=false',
    MANAGED_LINE,
    ...(o.autostart ? ['X-GNOME-Autostart-enabled=true'] : ['Categories=System;Monitor;']),
    '',
  ].join('\n');
}

/**
 * Écrit l'entrée de menu et copie l'icône de l'app dans le thème hicolor de l'utilisateur (`Icon=computer-watcher`).
 * Une icône introuvable n'empêche pas l'entrée : le bureau affichera son icône par défaut.
 * Dossiers ouverts sans suivre de lien (refusés s'ils en sont un), écriture atomique ; une entrée existante sans
 * X-ProcWatch-Managed=1 n'est jamais écrasée (erreur).
 */
export function installDesktopEntry(target: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir(), iconPng?: string): string {
  if (hasControlChars(target)) throw new Error('Chemin refusé (caractère de contrôle)');
  const data = xdgHome(env, 'XDG_DATA_HOME', join(home, '.local/share'));
  const roots = [home, data];
  const content = desktopEntryContent(target);
  const file = join(data, 'applications', `${APP_NAME}.desktop`);
  const guard = (current: string | null) =>
    current !== null && !isManagedEntry(current) ? `${file} n’a pas été créé par ${APP_DISPLAY_NAME} (sans X-ProcWatch-Managed=1) : laissé en place` : null;
  if (iconPng) {
    try {
      writeFileSafe(roots, join(data, `icons/hicolor/512x512/apps/${APP_NAME}.png`), readFileSync(iconPng));
    } catch {
      // icône facultative
    }
  }
  writeFileSafe(roots, file, content, 0o644, { guard });
  return file;
}

/** Inverse de quoteExecArg pour la ligne `Exec="…"` d'une entrée de menu (sans argument) ; autre forme → null. */
export function execPathFromEntry(text: string): string | null {
  const e = execFromEntry(text);
  return e && e.args.length === 0 ? e.path : null;
}

/**
 * Ligne `Exec="…" [arguments simples]` écrite par desktopEntryContent : chemin (inverse de quoteExecArg) et arguments
 * (seulement ceux de SAFE_ARG, comme `--hidden`) ; autre forme → null.
 */
export function execFromEntry(text: string): { path: string; args: string[] } | null {
  const m = /^Exec="(.*)"((?: [A-Za-z0-9_\-=./]+)*)$/m.exec(text);
  if (!m) return null;
  // règle des chaînes (\\ → \, \n, \t, \r, \s), puis règle des guillemets (\X → X), et %% → %
  const str = m[1]!.replace(/%%/g, '%').replace(/\\([\\nrts])/g, (_, c: string) => ({ '\\': '\\', n: '\n', r: '\r', t: '\t', s: ' ' })[c]!);
  return { path: str.replace(/\\(.)/g, '$1'), args: m[2]!.split(' ').filter(Boolean) };
}

/**
 * Après une mise à jour de l'AppImage sous un nouveau nom (electron-updater supprime l'ancienne et place la nouvelle dans le
 * même dossier) : le raccourci écrit par l'app (clé X-ProcWatch-Managed) est repointé sur `appImage`, seulement si
 * son ancienne cible n'existe plus et que `appImage` est dans le même dossier. Lancer une autre copie ne le détourne jamais.
 * Lecture et écriture sans suivre de lien (dossiers compris).
 */
export function refreshDesktopEntry(
  appImage: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): 'absent' | 'unchanged' | 'updated' | 'kept' | 'foreign' | 'refused' {
  if (hasControlChars(appImage)) return 'refused';
  const data = xdgHome(env, 'XDG_DATA_HOME', join(home, '.local/share'));
  const roots = [home, data];
  const file = join(data, 'applications', `${APP_NAME}.desktop`);
  const text = readFileSafe(roots, file);
  if (text === null) return 'absent';
  const want = desktopEntryContent(appImage);
  if (text === want) return 'unchanged';
  if (!isManagedEntry(text)) return 'foreign';
  const old = execPathFromEntry(text);
  if (old === null) return 'foreign';
  if (existsSync(old) || dirname(old) !== dirname(appImage)) return 'kept';
  writeFileSafe(roots, file, want, 0o644, { guard: (cur) => (cur !== null && !isManagedEntry(cur) ? 'foreign' : null) });
  return 'updated';
}
