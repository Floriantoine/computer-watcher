// « Ignorer 30 min » de la prévision ② : fichier d'état partagé par le service (bouton de la notification) et le main
// (bouton du pop-up de l'app), pour survivre à un redémarrage du service.
import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SNOOZE_MS } from './forecast';

/** Décalage d'horloge toléré entre le processus qui écrit et celui qui lit. */
const CLOCK_SKEW_MS = 60_000;

/**
 * Fin de la période ignorée (ms), ou null (absent, illisible, invalide). Le fichier porte l'heure de la demande
 * (`setAt`) : la pause n'est valable que si elle se termine au plus 30 min après cette demande, et si la demande
 * n'est pas datée du futur. Ainsi un fichier corrompu ou forgé ne peut jamais couper la prévision plus d'une fois
 * 30 min, et relire le fichier ne prolonge jamais la pause (l'ancienne borne « maintenant + 30 min » la repoussait
 * à chaque relecture).
 */
export function readSnooze(path: string, now: number = Date.now()): number | null {
  try {
    const o = JSON.parse(readFileSync(path, 'utf8')) as { snoozedUntil?: unknown; setAt?: unknown } | null;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const { snoozedUntil: until, setAt } = o;
    if (typeof until !== 'number' || !Number.isFinite(until) || until < 0) return null;
    if (typeof setAt !== 'number' || !Number.isFinite(setAt) || setAt < 0) return null;
    if (setAt > now + CLOCK_SKEW_MS) return null;
    if (until <= setAt || until > setAt + SNOOZE_MS) return null;
    return until;
  } catch {
    return null;
  }
}

/** Écriture atomique (fichier temporaire puis renommage), 0600 ; `setAt` = heure de la demande. */
export function writeSnooze(path: string, snoozedUntil: number, setAt: number = Date.now()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ snoozedUntil, setAt }), { mode: 0o600 });
  renameSync(tmp, path);
}
