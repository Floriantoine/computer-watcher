// Bouton « Redémarrer le service » (fenêtre, logique pure) : où il s'affiche.
import type { GroupSummary } from '../../core/types';

/**
 * Carte ou ligne qui contient le processus du service d'enregistrement (`servicePid`, null s'il ne mesure pas). Jamais
 * « Autres » : repliée, elle regroupe les pids de ses sous-groupes et son pied de carte est « Déplier ».
 */
export function hasService(group: Pick<GroupSummary, 'kind' | 'pids'>, servicePid: number | null): boolean {
  return servicePid !== null && group.kind !== 'others' && group.pids.includes(servicePid);
}
