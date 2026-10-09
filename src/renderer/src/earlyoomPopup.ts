// Pop-up « earlyoom n'est pas installé / pas actif » au lancement (B8 bis) : textes et décisions (logique pure).
import { APP_DISPLAY_NAME } from '../../core/appName';
import { setupNeed, type EarlyoomServiceState, type EarlyoomSetupMode } from '../../core/earlyoomSetup';
import type { ApplyResult } from '../../core/types';

export interface EarlyoomPopupText { title: string; body: string; primary: string; later: string; snooze: string }

export function earlyoomPopupText(mode: EarlyoomSetupMode): EarlyoomPopupText {
  const common = { later: 'Plus tard', snooze: 'Ne plus rappeler pendant 7 jours' };
  return mode === 'install'
    ? {
        ...common,
        title: '⚠ Attention : earlyoom n’est pas installé',
        body: `Sans earlyoom, une mémoire saturée peut geler tout le système. ${APP_DISPLAY_NAME} peut l’installer, le configurer (terminaux, Claude et session toujours exclus) et l’activer, avec un seul mot de passe administrateur.`,
        primary: 'Installer et configurer',
      }
    : {
        ...common,
        title: '⚠ Attention : earlyoom n’est pas actif',
        body: `earlyoom est installé mais ne tourne pas, ou ne démarre pas avec le système : une mémoire saturée peut geler tout le système. ${APP_DISPLAY_NAME} peut le configurer et l’activer, avec un seul mot de passe administrateur.`,
        primary: 'Activer',
      };
}

/**
 * Après « Installer et configurer » / « Activer » : réussi → fermé ; état changé entre-temps (`stale`) → état relu, le pop-up
 * passe au nouveau mode (ou se ferme s'il n'y a plus rien à faire) ; sinon reste ouvert (réessayer ou fermer).
 */
export function popupAfterSetup(r: ApplyResult): 'close' | 'keep' | 'refresh' {
  if (r.ok) return 'close';
  return r.reason === 'stale' ? 'refresh' : 'keep';
}

/** Bouton de Réglages › earlyoom : même mot-clé que le pop-up, ou rien si earlyoom est actif et lancé au démarrage. */
export function settingsSetupAction(s: EarlyoomServiceState): { mode: EarlyoomSetupMode; label: string } | null {
  const mode = setupNeed(s);
  if (!mode) return null;
  return { mode, label: mode === 'install' ? 'Installer et configurer (mot de passe)' : 'Activer (mot de passe)' };
}
