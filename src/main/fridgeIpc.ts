// IPC `antigel:fridge` (anti-gel lot 3) : le renderer n'envoie que l'identifiant du groupe de projet (« project:<racine> ») et
// l'action ; le main valide, vérifie que le projet est sous le plafond de travail (état frais du service) pour « frigo »,
// puis dépose une demande. Le main n'appelle jamais busctl : le service revalide tout et agit à son tick suivant.
import { fridgeRoot } from '../core/antigel/fridgeState';
import { writeFridgeRequest } from '../core/antigel/fridgeRequest';
import { readAntigelView } from './antigelIpc';

export type FridgeIpcResult = { queued: true };

export function requestFridge(dataDir: string, now: number, intervalSec: number, groupId: unknown, action: unknown): FridgeIpcResult {
  if (action !== 'freeze' && action !== 'thaw') throw new Error('Action refusée');
  const root = typeof groupId === 'string' && groupId.startsWith('project:') ? fridgeRoot(groupId.slice('project:'.length)) : null;
  if (root === null) throw new Error('Projet refusé');
  if (action === 'freeze') {
    // réveiller est toujours permis (sens sûr) ; mettre au frigo seulement un projet plafonné, service actif
    const v = readAntigelView(dataDir, now, intervalSec);
    const s = v.fresh ? v.state : null;
    if (!s || s.status !== 'active' || !s.enabled) throw new Error('Plafond de travail inactif ou service d’enregistrement arrêté : rien n’est mis au frigo.');
    if (!s.projects.some((p) => p.root === root && p.procs > 0)) throw new Error('Aucun processus de ce projet n’est sous le plafond de travail.');
  }
  writeFridgeRequest(dataDir, { root, action, at: now });
  return { queued: true };
}
