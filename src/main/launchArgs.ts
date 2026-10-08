// src/main/launchArgs.ts — « Libérer de la mémoire » : `--free` (lanceur, barre des tâches) ouvre le kill groupé pré-rempli.
import { deferSend } from './alerts';

export const FREE_FLAG = '--free';
export const wantsFree = (argv: readonly string[]): boolean => argv.includes(FREE_FLAG);

/**
 * Demande « Libérer » vers le renderer : envoyée tout de suite (fenêtre chargée) et gardée jusqu'à ce que le renderer la
 * prenne (`take`) au montage, au cas où la fenêtre n'était pas encore prête.
 */
export function createFreeOpener(send: () => void) {
  let pending = false;
  return {
    open() {
      pending = true;
      deferSend(send);
    },
    take(): boolean {
      const p = pending;
      pending = false;
      return p;
    },
  };
}
