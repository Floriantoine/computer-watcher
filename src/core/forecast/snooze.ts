// « Ignorer 30 min » de la prévision ② : fichier d'état partagé par le service (bouton de la notification) et le main
// (bouton du pop-up de l'app), pour survivre à un redémarrage du service.
import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Fin de la période ignorée (ms), ou null (absent, illisible). */
export function readSnooze(path: string): number | null {
  try {
    const o = JSON.parse(readFileSync(path, 'utf8')) as { snoozedUntil?: unknown };
    return typeof o.snoozedUntil === 'number' && Number.isFinite(o.snoozedUntil) ? o.snoozedUntil : null;
  } catch {
    return null;
  }
}

/** Écriture atomique (fichier temporaire puis renommage), 0600. */
export function writeSnooze(path: string, snoozedUntil: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ snoozedUntil }), { mode: 0o600 });
  renameSync(tmp, path);
}
