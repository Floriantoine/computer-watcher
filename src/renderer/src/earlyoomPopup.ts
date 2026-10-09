// Pop-up « earlyoom n'est pas installé / pas actif » au lancement (B8 bis) : textes et décisions (logique pure).
import { setupNeed, type EarlyoomServiceState, type EarlyoomSetupMode } from '../../core/earlyoomSetup';
import type { ApplyResult } from '../../core/types';

export interface EarlyoomPopupText { title: string; body: string; primary: string; later: string; snooze: string }

export function earlyoomPopupText(mode: EarlyoomSetupMode): EarlyoomPopupText {
  const common = { later: 'Plus tard', snooze: 'Ne plus rappeler pendant 7 jours' };
  return mode === 'install'
    ? {
        ...common,
        title: '⚠ Attention : earlyoom n’est pas installé',
        body: 'Sans earlyoom, une mémoire saturée peut geler tout le système. proc-watch peut l’installer, le configurer (terminaux, Claude et session toujours exclus) et l’activer, avec un seul mot de passe administrateur.',
        primary: 'Installer et configurer',
      }
    : {
        ...common,
        title: '⚠ Attention : earlyoom n’est pas actif',
        body: 'earlyoom est installé mais ne tourne pas, ou ne démarre pas avec le système : une mémoire saturée peut geler tout le système. proc-watch peut le configurer et l’activer, avec un seul mot de passe administrateur.',
        primary: 'Activer',
      };
}

/** Après « Installer et configurer » / « Activer » : réussi ou plus rien à faire → fermé ; sinon reste ouvert (réessayer ou fermer). */
export function popupAfterSetup(r: ApplyResult): 'close' | 'keep' {
  return r.ok || r.reason === 'stale' ? 'close' : 'keep';
}

/** Bouton de Réglages › earlyoom : même mot-clé que le pop-up, ou rien si earlyoom est actif et lancé au démarrage. */
export function settingsSetupAction(s: EarlyoomServiceState): { mode: EarlyoomSetupMode; label: string } | null {
  const mode = setupNeed(s);
  if (!mode) return null;
  return { mode, label: mode === 'install' ? 'Installer et configurer (mot de passe)' : 'Activer (mot de passe)' };
}
