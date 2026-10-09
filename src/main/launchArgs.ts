// src/main/launchArgs.ts — « Libérer de la mémoire » : `--free` (lanceur, barre des tâches) ouvre le kill groupé pré-rempli.
import { deferSend } from './alerts';

export const FREE_FLAG = '--free';
export const wantsFree = (argv: readonly string[]): boolean => argv.includes(FREE_FLAG);

/** `--hidden` (démarrage avec la session, ~/.config/autostart) : l'app démarre sans montrer sa fenêtre. */
export const HIDDEN_FLAG = '--hidden';
export const wantsHidden = (argv: readonly string[]): boolean => argv.includes(HIDDEN_FLAG);

/** La fenêtre est-elle montrée à sa création ? Non avec `--hidden` : elle est placée une fois la barre des tâches connue. */
export const startWindowShown = (argv: readonly string[]): boolean => !wantsHidden(argv);

/** Démarrage caché : dans la barre des tâches si l'icône existe réellement, sinon fenêtre réduite (jamais invisible). */
export const hiddenPlacement = (trayActive: boolean): 'tray' | 'minimized' => (trayActive ? 'tray' : 'minimized');

/** Second lancement pendant que l'app tourne : `--free` ouvre « Libérer », `--hidden` seul ne change rien, sinon montrer. */
export function secondInstanceAction(argv: readonly string[]): 'free' | 'ignore' | 'show' {
  if (wantsFree(argv)) return 'free';
  if (wantsHidden(argv)) return 'ignore';
  return 'show';
}

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
