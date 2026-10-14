// Page Disque, lot 2 (pur) : dossiers de ~/.cache hors des familles connues (« inconnu : vérifie avant »).
import { APP_NAME, LEGACY_APP_NAME } from '../appName';
import { FAMILIES, familyPaths, type FamilyRoots } from './families';

/** Premiers composants, sous XDG_CACHE_HOME, des chemins des familles connues ; plus les dossiers de l'app. */
export function knownCacheNames(r: FamilyRoots): Set<string> {
  const base = r.cacheHome.replace(/\/+$/, '');
  const out = new Set<string>([APP_NAME, LEGACY_APP_NAME, `${APP_NAME}-updater`, `${LEGACY_APP_NAME}-updater`]);
  for (const f of FAMILIES) for (const p of familyPaths(f.id, r)) if (p.startsWith(`${base}/`)) out.add(p.slice(base.length + 1).split('/')[0]);
  return out;
}

/**
 * Nom d'un dossier de ~/.cache que l'explorateur peut proposer : un seul composant, jamais une famille connue, jamais un
 * nom en `.asar` (sous Electron, `fs` lirait un tel fichier comme une archive vue comme un dossier, lstat compris).
 */
export function isExplorableName(name: string, known: ReadonlySet<string>): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\0') &&
    !name.toLowerCase().endsWith('.asar') &&
    !known.has(name)
  );
}
