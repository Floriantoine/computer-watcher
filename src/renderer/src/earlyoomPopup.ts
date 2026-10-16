// Pop-up « earlyoom n'est pas installé / pas actif » au lancement (B8 bis) : textes et décisions (logique pure).
import { APP_DISPLAY_NAME } from '../../core/appName';
import {
  setupNeed, upgradeChanges, type EarlyoomReminderKind, type EarlyoomServiceState, type EarlyoomSetupMode, type EarlyoomUpgrade,
} from '../../core/earlyoomSetup';
import type { ApplyResult } from '../../core/types';

export interface EarlyoomPopupText { title: string; body: string; primary: string; busy: string; later: string; snooze: string }

/** Changements de la mise à niveau, une ligne chacun (pop-up, carte de Réglages, accueil). */
export const upgradeSummary = (u: EarlyoomUpgrade): string[] => upgradeChanges(u);

export function earlyoomPopupText(mode: EarlyoomReminderKind, up?: EarlyoomUpgrade | null): EarlyoomPopupText {
  const common = { later: 'Plus tard', snooze: 'Ne plus rappeler pendant 7 jours' };
  if (mode === 'upgrade') {
    const what = up
      ? upgradeSummary(up).join(' ')
      : 'Les processus Node récents (MainThread : jest, tsc, eslint…) seront tués en premier, et earlyoom réagira plus tôt. Aucune exclusion retirée.';
    return {
      ...common,
      title: 'Protection anti-gel à mettre à jour',
      body: `La configuration d’earlyoom installée par ${APP_DISPLAY_NAME} ne vise pas les processus Node récents (jest, tsc, eslint… apparaissent sous le nom « MainThread ») : earlyoom peut tuer un petit onglet pendant qu’un test de plusieurs Go continue. ${what} Un seul mot de passe administrateur.`,
      primary: 'Mettre à jour',
      busy: 'Mise à jour…',
    };
  }
  return mode === 'install'
    ? {
        ...common,
        title: '⚠ Attention : earlyoom n’est pas installé',
        body: `Sans earlyoom, une mémoire saturée peut geler tout le système. ${APP_DISPLAY_NAME} peut l’installer, le configurer (terminaux, Claude et session toujours exclus) et l’activer, avec un seul mot de passe administrateur.`,
        primary: 'Installer et configurer',
        busy: 'Installation…',
      }
    : {
        ...common,
        title: '⚠ Attention : earlyoom n’est pas actif',
        body: `earlyoom est installé mais ne tourne pas, ou ne démarre pas avec le système : une mémoire saturée peut geler tout le système. ${APP_DISPLAY_NAME} peut le configurer et l’activer, avec un seul mot de passe administrateur.`,
        primary: 'Activer',
        busy: 'Activation…',
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
