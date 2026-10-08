// « Ignorer 30 min » de la prévision ② : fichier d'état partagé par le service (bouton de la notification) et le main
// (bouton du pop-up de l'app), pour survivre à un redémarrage du service.
import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SNOOZE_MS } from './forecast';

/**
 * Fin de la période ignorée (ms), ou null (absent, illisible, valeur invalide). Bornée à `now + 30 min` : un fichier
 * corrompu ou une horloge faussée ne coupe jamais la prévision plus longtemps qu'un « Ignorer 30 min ».
 */
export function readSnooze(path: string, now: number = Date.now()): number | null {
  try {
    const o = JSON.parse(readFileSync(path, 'utf8')) as { snoozedUntil?: unknown } | null;
    const v = o && typeof o === 'object' && !Array.isArray(o) ? o.snoozedUntil : undefined;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
    return Math.min(v, now + SNOOZE_MS);
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
