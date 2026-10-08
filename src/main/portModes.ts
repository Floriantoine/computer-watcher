import { wantsAllPorts } from '../core/snapshot';
import type { Watch } from '../core/types';

/**
 * Lectures de ports : `classify` = ports du périmètre du classement (réglage « Détecter les ports ») ; `sweep` = ports de tous les
 * processus de l'utilisateur (panneau « Ports ouverts » ou recherche `:port`), indépendant du réglage, jamais fenêtre cachée ou réduite.
 */
export function portModes(o: { detectPorts: boolean; watch: Watch; visible: boolean }): { classify: boolean; sweep: boolean } {
  return { classify: o.detectPorts, sweep: o.visible && wantsAllPorts(o.watch) };
}
